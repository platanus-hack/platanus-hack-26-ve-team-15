// Persistencia en SQLite (node:sqlite). Para Postgres basta reimplementar esta clase:
// toda la lógica de negocio pasa por estos métodos.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  sender_id TEXT PRIMARY KEY, display_name TEXT NOT NULL,
  sign_pk BLOB NOT NULL, seal_pk BLOB NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS contacts (
  sender_id TEXT NOT NULL, idx INTEGER NOT NULL, name TEXT NOT NULL, relation TEXT,
  lang TEXT NOT NULL DEFAULT 'es', sms TEXT, email TEXT, voice TEXT,
  status TEXT NOT NULL DEFAULT 'pending_verification', PRIMARY KEY (sender_id, idx));
CREATE TABLE IF NOT EXISTS incidents (
  sender_id TEXT NOT NULL, incident_id TEXT NOT NULL, category INTEGER, severity INTEGER,
  lat INTEGER, lon INTEGER, accuracy_m INTEGER, location_age INTEGER, loc_timestamp INTEGER,
  public_text TEXT, note TEXT, status TEXT NOT NULL DEFAULT 'open', hops INTEGER,
  egress_id TEXT, blob_readable INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  last_seq INTEGER NOT NULL DEFAULT 0, notified_count INTEGER NOT NULL DEFAULT 0,
  rx_cursor INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (sender_id, incident_id));
CREATE TABLE IF NOT EXISTS packets (
  sender_id TEXT NOT NULL, incident_id TEXT NOT NULL, seq INTEGER NOT NULL, msg_type INTEGER NOT NULL,
  ack_b64 TEXT NOT NULL, egress_id TEXT, envelope_ttl INTEGER, hops INTEGER, rx_at INTEGER,
  PRIMARY KEY (sender_id, incident_id, seq, msg_type));
CREATE TABLE IF NOT EXISTS mailbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sender_id TEXT NOT NULL, incident_id TEXT NOT NULL,
  msg_type INTEGER NOT NULL, srv_seq INTEGER NOT NULL, created_at INTEGER NOT NULL, packet_b64 TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS mailbox_lookup ON mailbox (sender_id, incident_id, id);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL,
  sender_id TEXT, incident_id TEXT, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sender_id TEXT NOT NULL, incident_id TEXT NOT NULL,
  contact_idx INTEGER NOT NULL, channel TEXT NOT NULL, state TEXT NOT NULL, detail TEXT, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS commands (
  sender_id TEXT NOT NULL, ref INTEGER NOT NULL, cmd TEXT NOT NULL, status INTEGER NOT NULL,
  result_text TEXT NOT NULL, amount REAL NOT NULL DEFAULT 0, at INTEGER NOT NULL, PRIMARY KEY (sender_id, ref));
CREATE TABLE IF NOT EXISTS wa_inbound (phone TEXT PRIMARY KEY, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS presence (
  egress_id TEXT PRIMARY KEY, cell TEXT NOT NULL, valid_until INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS radio_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT, egress_id TEXT NOT NULL, mailbox_id INTEGER NOT NULL,
  UNIQUE (egress_id, mailbox_id));
`;

function channelValues(c) {
  return { sms: c.channels.sms ?? null, email: c.channels.email ?? null, voice: c.channels.voice ?? null };
}

/** Un contacto conserva "verified" solo si no cambió ningún canal. */
function keepsVerification(prev, ch) {
  return Boolean(prev) && prev.sms === ch.sms && prev.email === ch.email && prev.voice === ch.voice;
}

function contactRow(senderId, c, prev) {
  const ch = channelValues(c);
  const status = keepsVerification(prev, ch) ? prev.status : 'pending_verification';
  return [senderId, c.index, c.name, c.relation ?? null, c.lang ?? 'es', ch.sms, ch.email, ch.voice, status];
}

export class Store {
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  /** Ejecuta `fn` en una transacción; si lanza, deshace todo. */
  tx(fn) {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // --- usuarios y contactos -------------------------------------------------------
  getUser(senderId) {
    return this.db.prepare('SELECT * FROM users WHERE sender_id = ?').get(senderId) ?? null;
  }

  upsertUser({ senderId, displayName, signPk, sealPk, now }) {
    this.db.prepare(`INSERT INTO users (sender_id, display_name, sign_pk, seal_pk, created_at) VALUES (?,?,?,?,?)
      ON CONFLICT(sender_id) DO UPDATE SET display_name = excluded.display_name, seal_pk = excluded.seal_pk`)
      .run(senderId, displayName, signPk, sealPk, now);
  }

  replaceContacts(senderId, contacts) {
    const existing = new Map(this.getContacts(senderId).map((c) => [c.idx, c]));
    this.tx(() => {
      this.db.prepare('DELETE FROM contacts WHERE sender_id = ?').run(senderId);
      const ins = this.db.prepare(`INSERT INTO contacts (sender_id, idx, name, relation, lang, sms, email, voice, status)
        VALUES (?,?,?,?,?,?,?,?,?)`);
      for (const c of contacts) ins.run(...contactRow(senderId, c, existing.get(c.index)));
    });
  }

  getContacts(senderId) {
    return this.db.prepare('SELECT * FROM contacts WHERE sender_id = ? ORDER BY idx').all(senderId);
  }

  getContact(senderId, idx) {
    return this.db.prepare('SELECT * FROM contacts WHERE sender_id = ? AND idx = ?').get(senderId, idx) ?? null;
  }

  setContactStatus(senderId, idx, status) {
    this.db.prepare('UPDATE contacts SET status = ? WHERE sender_id = ? AND idx = ?').run(status, senderId, idx);
  }

  // --- paquetes (idempotencia) ----------------------------------------------------
  getPacket(senderId, incidentId, seq, msgType) {
    return this.db.prepare('SELECT * FROM packets WHERE sender_id=? AND incident_id=? AND seq=? AND msg_type=?')
      .get(senderId, incidentId, seq, msgType) ?? null;
  }

  insertPacket(p) {
    this.db.prepare(`INSERT INTO packets (sender_id, incident_id, seq, msg_type, ack_b64, egress_id, envelope_ttl, hops, rx_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(p.senderId, p.incidentId, p.seq, p.msgType, p.ackB64, p.egressId, p.envelopeTtl, p.hops, p.rxAt);
  }

  // --- incidentes -----------------------------------------------------------------
  getIncident(senderId, incidentId) {
    return this.db.prepare('SELECT * FROM incidents WHERE sender_id = ? AND incident_id = ?').get(senderId, incidentId) ?? null;
  }

  createIncident(i) {
    this.db.prepare(`INSERT INTO incidents (sender_id, incident_id, category, severity, lat, lon, accuracy_m, location_age,
      loc_timestamp, public_text, note, status, hops, egress_id, blob_readable, created_at, updated_at, last_seq)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(i.senderId, i.incidentId, i.category, i.severity, i.lat, i.lon, i.accuracyM, i.locationAge, i.locTimestamp,
        i.publicText, i.note, i.status ?? 'open', i.hops, i.egressId, i.blobReadable ? 1 : 0, i.now, i.now, i.seq);
  }

  updateIncident(senderId, incidentId, f) {
    const cols = [];
    const vals = [];
    const map = { category: 'category', severity: 'severity', lat: 'lat', lon: 'lon', accuracyM: 'accuracy_m',
      locationAge: 'location_age', locTimestamp: 'loc_timestamp', publicText: 'public_text', note: 'note',
      status: 'status', hops: 'hops', egressId: 'egress_id', blobReadable: 'blob_readable', updatedAt: 'updated_at',
      lastSeq: 'last_seq', notifiedCount: 'notified_count', rxCursor: 'rx_cursor' };
    for (const [k, v] of Object.entries(f)) {
      if (!map[k]) throw new Error(`unknown incident field ${k}`);
      cols.push(`${map[k]} = ?`);
      vals.push(typeof v === 'boolean' ? Number(v) : v);
    }
    this.db.prepare(`UPDATE incidents SET ${cols.join(', ')} WHERE sender_id = ? AND incident_id = ?`)
      .run(...vals, senderId, incidentId);
  }

  listIncidents({ status, limit = 200 } = {}) {
    const where = status ? 'WHERE status = ?' : '';
    const args = status ? [status, limit] : [limit];
    return this.db.prepare(`SELECT i.*, u.display_name FROM incidents i LEFT JOIN users u USING (sender_id)
      ${where} ORDER BY updated_at DESC LIMIT ?`).all(...args);
  }

  findIncidentById(incidentId) {
    return this.db.prepare('SELECT * FROM incidents WHERE incident_id = ? ORDER BY created_at DESC').all(incidentId);
  }

  // --- buzón ----------------------------------------------------------------------
  nextServerSeq(senderId, incidentId) {
    const r = this.db.prepare(`SELECT COALESCE(MAX(srv_seq), 0) AS m FROM mailbox
      WHERE sender_id = ? AND incident_id = ? AND msg_type IN (5, 7)`).get(senderId, incidentId);
    return r.m + 1;
  }

  addMailbox({ senderId, incidentId, msgType, srvSeq, createdAt, packetB64 }) {
    const r = this.db.prepare(`INSERT INTO mailbox (sender_id, incident_id, msg_type, srv_seq, created_at, packet_b64)
      VALUES (?,?,?,?,?,?)`).run(senderId, incidentId, msgType, srvSeq, createdAt, packetB64);
    return Number(r.lastInsertRowid);
  }

  getMailboxEntry(id) {
    return this.db.prepare('SELECT * FROM mailbox WHERE id = ?').get(id) ?? null;
  }

  pollMailbox({ senderId, incidentIds, afterId, minCreatedAt, limit }) {
    if (!incidentIds.length) return [];
    const marks = incidentIds.map(() => '?').join(',');
    return this.db.prepare(`SELECT * FROM mailbox WHERE sender_id = ? AND incident_id IN (${marks})
      AND id > ? AND created_at >= ? ORDER BY id LIMIT ?`)
      .all(senderId, ...incidentIds, afterId, minCreatedAt, limit);
  }

  purgeMailbox(olderThan) {
    this.db.prepare('DELETE FROM mailbox WHERE created_at < ?').run(olderThan);
  }

  // --- eventos, avisos, comandos ----------------------------------------------------
  addEvent({ at, kind, senderId = null, incidentId = null, data = {} }) {
    const r = this.db.prepare('INSERT INTO events (at, kind, sender_id, incident_id, data) VALUES (?,?,?,?,?)')
      .run(at, kind, senderId, incidentId, JSON.stringify(data));
    return Number(r.lastInsertRowid);
  }

  listEvents({ afterId = 0, incidentId, limit = 200 } = {}) {
    const rows = incidentId
      ? this.db.prepare('SELECT * FROM events WHERE id > ? AND incident_id = ? ORDER BY id LIMIT ?').all(afterId, incidentId, limit)
      : this.db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?').all(afterId, limit);
    return rows.map((r) => ({ ...r, data: JSON.parse(r.data) }));
  }

  addNotification({ senderId, incidentId, contactIdx, channel, state, detail = null, at }) {
    this.db.prepare(`INSERT INTO notifications (sender_id, incident_id, contact_idx, channel, state, detail, at)
      VALUES (?,?,?,?,?,?,?)`).run(senderId, incidentId, contactIdx, channel, state, detail, at);
  }

  listNotifications(senderId, incidentId) {
    return this.db.prepare('SELECT * FROM notifications WHERE sender_id = ? AND incident_id = ? ORDER BY id')
      .all(senderId, incidentId);
  }

  /** Último incidente al que se avisó a un contacto cuyo número SMS/voz coincide. */
  findNotifiedIncidentByPhone(digits) {
    return this.db.prepare(`SELECT n.sender_id, n.incident_id, n.contact_idx FROM notifications n
      JOIN contacts c ON c.sender_id = n.sender_id AND c.idx = n.contact_idx
      WHERE n.state IN ('sent', 'simulated', 'delivered', 'read')
        AND (REPLACE(REPLACE(REPLACE(REPLACE(c.sms,'+',''),' ',''),'-',''),'(','') LIKE ?
          OR REPLACE(REPLACE(REPLACE(REPLACE(c.voice,'+',''),' ',''),'-',''),'(','') LIKE ?)
      ORDER BY n.id DESC LIMIT 1`).get(`%${digits}`, `%${digits}`) ?? null;
  }

  /** Último mensaje que un número nos escribió por WhatsApp (abre la ventana de 24 h para texto libre). */
  touchWaInbound(phone, at) {
    this.db.prepare(`INSERT INTO wa_inbound (phone, at) VALUES (?, ?)
      ON CONFLICT(phone) DO UPDATE SET at = MAX(at, excluded.at)`).run(phone, at);
  }

  getWaInbound(phone) {
    return this.db.prepare('SELECT at FROM wa_inbound WHERE phone = ?').get(phone)?.at ?? null;
  }

  /** Actualiza el estado de un aviso a partir del id del mensaje del proveedor (entregado, leído, fallido). */
  updateNotificationByWamid(wamid, state) {
    const r = this.db.prepare(`UPDATE notifications SET state = ? WHERE detail LIKE ? AND state IN ('sent', 'delivered', 'read')`)
      .run(state, `%:wamid:${wamid}`);
    return Number(r.changes);
  }

  getCommand(senderId, ref) {
    return this.db.prepare('SELECT * FROM commands WHERE sender_id = ? AND ref = ?').get(senderId, ref) ?? null;
  }

  addCommand({ senderId, ref, cmd, status, resultText, amount = 0, at }) {
    this.db.prepare('INSERT INTO commands (sender_id, ref, cmd, status, result_text, amount, at) VALUES (?,?,?,?,?,?,?)')
      .run(senderId, ref, cmd, status, resultText, amount, at);
  }

  sumCommandAmountSince(senderId, since) {
    return this.db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM commands WHERE sender_id = ? AND at >= ? AND status = 0')
      .get(senderId, since).s;
  }

  countCommandsSince(senderId, since) {
    return this.db.prepare('SELECT COUNT(*) AS n FROM commands WHERE sender_id = ? AND at >= ? AND status = 0')
      .get(senderId, since).n;
  }

  // --- presencia y envío por radio (R5) -----------------------------------------------
  upsertPresence({ egressId, cell, validUntil }) {
    this.db.prepare(`INSERT INTO presence (egress_id, cell, valid_until) VALUES (?,?,?)
      ON CONFLICT(egress_id) DO UPDATE SET cell = excluded.cell, valid_until = excluded.valid_until`)
      .run(egressId, cell, validUntil);
  }

  listPresence(now) {
    return this.db.prepare('SELECT * FROM presence WHERE valid_until >= ?').all(now);
  }

  enqueueRadio(egressId, mailboxId) {
    this.db.prepare('INSERT OR IGNORE INTO radio_queue (egress_id, mailbox_id) VALUES (?, ?)').run(egressId, mailboxId);
  }

  /** Mensajes en cola para un egress, aún no cubiertos por el rx_cursor del origen. */
  drainRadio(egressId, minCreatedAt) {
    return this.db.prepare(`SELECT q.id AS qid, m.* FROM radio_queue q JOIN mailbox m ON m.id = q.mailbox_id
      WHERE q.egress_id = ? AND m.created_at >= ?
        AND (m.msg_type = 3 OR m.srv_seq > COALESCE((SELECT rx_cursor FROM incidents i
          WHERE i.sender_id = m.sender_id AND i.incident_id = m.incident_id), 0))
      ORDER BY q.id`).all(egressId, minCreatedAt);
  }

  /** Mensajes 5/7 que el origen aún no confirmó (rx_cursor menor que su seq), para repetir el envío. */
  listUnreceivedServerMessages(minCreatedAt) {
    return this.db.prepare(`SELECT m.* FROM mailbox m JOIN incidents i ON i.sender_id = m.sender_id AND i.incident_id = m.incident_id
      WHERE m.msg_type IN (5, 7) AND m.created_at >= ? AND m.srv_seq > i.rx_cursor`).all(minCreatedAt);
  }

  dropRadioCovered(senderId, incidentId, cursor) {
    this.db.prepare(`DELETE FROM radio_queue WHERE mailbox_id IN (SELECT id FROM mailbox
      WHERE sender_id = ? AND incident_id = ? AND msg_type IN (5, 7) AND srv_seq <= ?)`).run(senderId, incidentId, cursor);
  }

  ackRadio(qids) {
    const del = this.db.prepare('DELETE FROM radio_queue WHERE id = ?');
    for (const id of qids) del.run(id);
  }
}
