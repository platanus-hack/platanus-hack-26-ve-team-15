// Microcrédito de emergencia SIMULADO, estilo Cashea: el usuario sin saldo ni conexión adelanta un Pago Móvil o
// una recarga contra un cupo y lo devuelve en 3 cuotas quincenales más una comisión de servicio.
// No mueve dinero ni llama a ningún banco: solo lleva la cuenta del cupo. Todo en centavos de USD (enteros).
// Las tablas viven aquí (no en store.js) y se crean la primera vez que se usa la base.

export const INSTALLMENTS = 3;
export const INSTALLMENT_DAYS = 14;
export const DEFAULT_LIMIT_CENTS = 5000; // US$ 50.00 por usuario
export const DEFAULT_FEE_BPS = 500; // 5 % de comisión de servicio

const DAY_S = 24 * 3600;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS credit_lines (
  sender_id TEXT PRIMARY KEY, limit_cents INTEGER NOT NULL, used_cents INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS credit_txs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sender_id TEXT NOT NULL, ref INTEGER NOT NULL, kind TEXT NOT NULL,
  amount_cents INTEGER NOT NULL, fee_cents INTEGER NOT NULL, installments INTEGER NOT NULL,
  destination TEXT NOT NULL, concept TEXT NOT NULL, receipt_ref TEXT NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE (sender_id, ref));
CREATE INDEX IF NOT EXISTS credit_txs_sender ON credit_txs (sender_id, id);
`;

const prepared = new WeakSet();

function db(ctx) {
  const handle = ctx.store.db;
  if (!prepared.has(handle)) {
    handle.exec(SCHEMA);
    prepared.add(handle);
  }
  return handle;
}

function settings(ctx) {
  const { limitCents = DEFAULT_LIMIT_CENTS, feeBps = DEFAULT_FEE_BPS } = ctx.config.credit ?? {};
  return { limitCents, feeBps };
}

/** Comisión y cuotas de un adelanto de `cents`; el resto de la división va a las primeras cuotas. */
export function planFor(cents, feeBps = DEFAULT_FEE_BPS) {
  const fee = Math.round((cents * feeBps) / 10_000);
  const total = cents + fee;
  const base = Math.floor(total / INSTALLMENTS);
  const extra = total - base * INSTALLMENTS;
  const parts = Array.from({ length: INSTALLMENTS }, (_, i) => base + (i < extra ? 1 : 0));
  return { fee, total, parts };
}

function lineOf(ctx, senderId) {
  const row = db(ctx).prepare('SELECT limit_cents, used_cents FROM credit_lines WHERE sender_id = ?').get(senderId);
  return row ?? { limit_cents: settings(ctx).limitCents, used_cents: 0 };
}

/** Cupo disponible de un usuario (sin crear nada si todavía no ha usado el crédito). */
export function availableCents(ctx, senderId) {
  const { limit_cents: limit, used_cents: used } = lineOf(ctx, senderId);
  return Math.max(0, limit - used);
}

/** Presupuesto de un adelanto sin registrarlo: `ok` es false si el cupo no alcanza. */
export function quote(ctx, senderId, cents) {
  const available = availableCents(ctx, senderId);
  const { feeBps } = settings(ctx);
  const { fee, total, parts } = planFor(cents, feeBps);
  return { ok: cents <= available, available, availableAfter: available - cents, fee, total, parts, feeBps };
}

/**
 * Registra el adelanto y descuenta el cupo de forma atómica. Idempotente por (sender_id, ref): repetir
 * el mismo ref no cobra dos veces. Devuelve false si el cupo ya no alcanza.
 */
export function charge(ctx, { senderId, ref, kind, cents, destination, concept, receiptRef }) {
  const { limitCents, feeBps } = settings(ctx);
  const { fee } = planFor(cents, feeBps);
  const handle = db(ctx);
  // SAVEPOINT en vez de BEGIN: el egress ya ejecuta el CMD dentro de su transacción y los savepoints se anidan.
  handle.exec('SAVEPOINT credit_charge');
  try {
    const taken = insertCharge(ctx, handle, { senderId, ref, kind, cents, fee, destination, concept, receiptRef, limitCents });
    handle.exec('RELEASE credit_charge');
    return taken;
  } catch (e) {
    handle.exec('ROLLBACK TO credit_charge');
    handle.exec('RELEASE credit_charge');
    throw e;
  }
}

function insertCharge(ctx, handle, { senderId, ref, kind, cents, fee, destination, concept, receiptRef, limitCents }) {
  if (handle.prepare('SELECT 1 FROM credit_txs WHERE sender_id = ? AND ref = ?').get(senderId, ref)) return true;
  handle.prepare('INSERT OR IGNORE INTO credit_lines (sender_id, limit_cents, used_cents, created_at) VALUES (?,?,0,?)')
    .run(senderId, limitCents, ctx.now());
  const taken = handle.prepare('UPDATE credit_lines SET used_cents = used_cents + ? WHERE sender_id = ? AND used_cents + ? <= limit_cents')
    .run(cents, senderId, cents);
  if (!taken.changes) return false;
  handle.prepare(`INSERT INTO credit_txs (sender_id, ref, kind, amount_cents, fee_cents, installments, destination, concept, receipt_ref, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(senderId, ref, kind, cents, fee, INSTALLMENTS, destination, concept, receiptRef, ctx.now());
  return true;
}

function txView(tx) {
  const totalCents = tx.amount_cents + tx.fee_cents;
  const base = Math.floor(totalCents / tx.installments);
  const extra = totalCents - base * tx.installments;
  return {
    ref: tx.receipt_ref, kind: tx.kind, amount_cents: tx.amount_cents, fee_cents: tx.fee_cents, total_cents: totalCents,
    destination: tx.destination, concept: tx.concept, created_at: tx.created_at,
    schedule: Array.from({ length: tx.installments }, (_, i) => ({
      n: i + 1, due_at: tx.created_at + (i + 1) * INSTALLMENT_DAYS * DAY_S, amount_cents: base + (i < extra ? 1 : 0),
    })),
  };
}

/** Estado del microcrédito para el panel: cupo, usado, disponible y los adelantos con su plan de cuotas. */
export function creditView(ctx, senderId) {
  const { limit_cents: limit, used_cents: used } = lineOf(ctx, senderId);
  const txs = db(ctx).prepare('SELECT * FROM credit_txs WHERE sender_id = ? ORDER BY id DESC LIMIT 50').all(senderId);
  return {
    sender_id: senderId, currency: 'USD', limit_cents: limit, used_cents: used, available_cents: Math.max(0, limit - used),
    fee_bps: settings(ctx).feeBps, installments: INSTALLMENTS, installment_days: INSTALLMENT_DAYS,
    transactions: txs.map(txView),
  };
}
