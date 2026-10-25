// Validadores de los argumentos de los CMD: esquemas estrictos que rechazan con un motivo corto.

export class ArgError extends Error {}

export function str(v, max, field) {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new ArgError(`${field} inválido`);
  return v.trim();
}

export function amount(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 100_000) throw new ArgError('monto inválido');
  return v;
}

export function currency(v) {
  if (typeof v !== 'string' || !/^[A-Za-z]{3}$/.test(v)) throw new ArgError('moneda inválida');
  return v.toUpperCase();
}
