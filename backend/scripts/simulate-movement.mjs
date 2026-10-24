#!/usr/bin/env node
// Simula el movimiento en tiempo real de una baliza SOS por el mesh en Caracas.
// Cada pocos segundos emite un paquete UPDATE con nuevas coordenadas GPS a lo largo
// de la Av. Francisco de Miranda (Chacao -> Altamira).
//
// Uso:
//   node scripts/simulate-movement.mjs [--url http://localhost:8090] [--phone 584123098258] [--label demo-mov-1] [--interval 2500]

import { createHash, sign } from 'node:crypto';
import { MSG, encodePacket, decodePacket, verifyPacket } from '../src/codec.js';
import { sealKeypairFromSeed, seal } from '../src/crypto.js';
import { ed25519FromLabel } from './synthetic.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const url = (opt('url', process.env.BALIZA_URL || 'http://localhost:8090')).replace(/\/$/, '');
const label = opt('label', `mov-${Date.now().toString(36)}`);
const phone = opt('phone', '584123098258');
const intervalMs = Number(opt('interval', 2500));

const post = async (path, body, headers = {}) => {
  const res = await fetch(url + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
};

const user = ed25519FromLabel(label);
const sealKp = sealKeypairFromSeed(createHash('sha256').update(`${label}:seal`).digest());
const contacts = [
  { index: 0, name: 'Contacto Principal', relation: 'familiar', lang: 'es', channels: { sms: phone, email: 'contacto@example.com' } },
];

console.log(`\n🛰️  Iniciando simulación de movimiento en tiempo real...`);
console.log(`Servidor: ${url}`);
console.log(`Usuario:  sender_id=${user.senderId} (etiqueta: ${label})`);
console.log(`Contacto WhatsApp: +${phone}\n`);

// 1. Registro del usuario
const regBody = JSON.stringify({
  display_name: 'Persona en Movimiento',
  sign_pk_b64: user.signPk.toString('base64'),
  seal_pk_b64: sealKp.publicKey.toString('base64'),
  contacts,
});

const reg = await post('/v1/users', regBody, {
  'x-baliza-pubkey': user.signPk.toString('base64'),
  'x-baliza-signature': sign(null, createHash('sha256').update(regBody).digest(), user.privateKey).toString('base64'),
});

if (reg.status !== 201) {
  console.error('Error registrando usuario:', reg.text);
  process.exit(1);
}

const serverSealPk = Buffer.from(reg.json.server.seal_pk_b64, 'base64');
const incidentId = createHash('sha256').update(`mov-${Date.now()}`).digest().subarray(0, 8).toString('hex');

const egress = (packet, hops = 2) => post('/v1/egress', {
  packet_b64: packet.toString('base64'),
  rx: { envelope_ttl: 7 - hops, egress_id: 'egress-chacao', rx_at: Math.floor(Date.now() / 1000) },
});

// Ruta de movimiento: 5 puntos a lo largo de Av. Francisco de Miranda
const WAYPOINTS = [
  { lat: 10.49250, lon: -66.85880, hops: 1, text: 'SOS inicial: atrapado en Chacao', note: 'Comenzando traslado a pie hacia zona segura' },
  { lat: 10.49380, lon: -66.85710, hops: 2, text: 'Avanzando por Av. Fco de Miranda', note: 'Cruzando Calle Joyeros, caminando despacio' },
  { lat: 10.49520, lon: -66.85530, hops: 2, text: 'Pasando frente a Bello Campo', note: 'Relevado por teléfono de un vecino (2 saltos BLE)' },
  { lat: 10.49650, lon: -66.85390, hops: 3, text: 'Cerca del Obelisco de Altamira', note: 'Divisando plaza Altamira, 3 saltos BLE' },
  { lat: 10.49750, lon: -66.85280, hops: 2, text: 'En zona segura: Plaza Altamira', note: 'Llegada a punto de socorro. Esperando asistencia.' },
];

const plaintext = (note) => {
  const head = Buffer.alloc(7);
  head.writeUInt32BE(0b1, 0); // contactMask
  head[4] = 0b011;            // channels
  head.writeUInt16BE(0, 5);   // rxCursor
  return Buffer.concat([head, Buffer.from(note, 'utf8')]);
};

for (let i = 0; i < WAYPOINTS.length; i++) {
  const wp = WAYPOINTS[i];
  const now = Math.floor(Date.now() / 1000);
  const isFirst = i === 0;

  const packet = encodePacket({
    msgType: isFirst ? MSG.SOS : MSG.UPDATE,
    ttl: 7,
    incidentId,
    seq: i + 1,
    category: 1, // médica
    severity: isFirst ? 3 : 2,
    lat: Math.round(wp.lat * 100000),
    lon: Math.round(wp.lon * 100000),
    accuracyM: Math.round(8 + Math.random() * 6),
    locationAge: 1,
    timestamp: now,
    publicText: wp.text,
    blob: seal(plaintext(wp.note), serverSealPk),
    signer: user,
  });

  const res = await egress(packet, wp.hops);
  const statusStr = res.status === 200 ? '✅ 200 OK' : `❌ ${res.status}`;
  console.log(`[Paso ${i + 1}/${WAYPOINTS.length}] ${isFirst ? '🚨 SOS' : '📍 UPDATE'} #${i + 1} | GPS: ${wp.lat.toFixed(5)}, ${wp.lon.toFixed(5)} (${wp.hops} saltos BLE) → ${statusStr}`);
  console.log(`   "${wp.text}"`);

  if (i < WAYPOINTS.length - 1) {
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

console.log(`\n🎉 Simulación de movimiento completada.`);
console.log(`Ver rastro en el dashboard: http://localhost:5173/?api=${url}\n`);
