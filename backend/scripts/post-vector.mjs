#!/usr/bin/env node
// Postea paquetes de prueba a un servidor Baliza Vital, sin teléfonos.
//
//   node scripts/post-vector.mjs [--url http://localhost:8080] [--raw] [--label baliza-synthetic-user-1]
//
// Modo por defecto (recomendado): registra al usuario sintético, arma paquetes NUEVOS con la hora actual
// y blobs sellados de verdad (crypto_box_seal) y comprueba: accepted → duplicate con el MISMO ACK →
// firma del ACK contra la llave del servidor → buzón.
//
// --raw: postea los bytes congelados de docs/examples/examples.json. Su timestamp es 2026-12-25, así que
// el servidor debe correr con BALIZA_NOW=1798200010 (o la ventana de tiempo los rechaza con 422).
// Sus blobs son relleno: el servidor los acepta pero no puede abrirlos (avisa a todos por SMS, ver README).
import { createHash, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MSG, decodePacket, verifyPacket } from '../src/codec.js';
import { sealKeypairFromSeed, seal } from '../src/crypto.js';
import { ed25519FromLabel, packetFor } from './synthetic.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const url = (opt('url', process.env.BALIZA_URL || 'http://localhost:8080')).replace(/\/$/, '');
const raw = args.includes('--raw');
const label = opt('label', 'baliza-synthetic-user-1');

let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? '  ok ' : ' FAIL'}  ${msg}`); if (!ok) failures += 1; };
const post = async (path, body, headers = {}) => {
  const res = await fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* no JSON */ }
  return { status: res.status, json, text };
};

const user = ed25519FromLabel(label);
// Llave X25519 estable por etiqueta, para poder abrir los MSG_IN en pruebas posteriores.
const sealKp = sealKeypairFromSeed(createHash('sha256').update(`${label}:seal`).digest());
const contacts = [
  { index: 0, name: 'Contacto Demo Uno', relation: 'familiar', lang: 'es', channels: { sms: '+58 000-0000001', email: 'contacto1@example.com', voice: '+58 000-0000001' } },
  { index: 1, name: 'Contacto Demo Dos', relation: 'amigo', lang: 'es', channels: { sms: '+58 000-0000002', voice: '+58 000-0000002' } },
];

console.log(`Servidor: ${url}   usuario sintético sender_id=${user.senderId}`);
const regBody = JSON.stringify({ display_name: 'Usuario Demo', sign_pk_b64: user.signPk.toString('base64'), seal_pk_b64: sealKp.publicKey.toString('base64'), contacts });
const reg = await post('/v1/users', regBody, {
  'x-baliza-pubkey': user.signPk.toString('base64'),
  'x-baliza-signature': sign(null, createHash('sha256').update(regBody).digest(), user.privateKey).toString('base64'),
});
check(reg.status === 201, `POST /v1/users → ${reg.status}`);
if (reg.status !== 201) { console.log(reg.text); process.exit(1); }
const serverSignPk = Buffer.from(reg.json.server.sign_pk_b64, 'base64');
const serverSealPk = Buffer.from(reg.json.server.seal_pk_b64, 'base64');
console.log(`  servidor key_id=${reg.json.server.key_id}`);

const egress = (packet) => post('/v1/egress', { packet_b64: packet.toString('base64'), rx: { envelope_ttl: 5, egress_id: 'post-vector', rx_at: Math.floor(Date.now() / 1000) } });

let incidentId;
if (raw) {
  const examples = JSON.parse(readFileSync(fileURLToPath(new URL('../../docs/examples/examples.json', import.meta.url)), 'utf8'));
  incidentId = examples.incident_id;
  for (const name of ['SOS', 'UPDATE']) {
    const r = await egress(Buffer.from(examples.packets[name].base64, 'base64'));
    check(r.status === 200, `vector ${name} → ${r.status} ${r.json?.status ?? r.text}`);
  }
} else {
  const now = Math.floor(Date.now() / 1000);
  const { sos, update, incident } = packetFor({ user, serverSealPk, now, seal });
  incidentId = incident;
  const first = await egress(sos);
  check(first.status === 200 && first.json.status === 'accepted', `SOS → ${first.status} ${first.json?.status}`);
  const ack = decodePacket(Buffer.from(first.json.ack_packet_b64, 'base64'));
  check(ack.msgType === MSG.ACK && ack.seq === 1 && verifyPacket(ack, serverSignPk), `ACK firmado por el servidor (código ${ack.category}: "${ack.publicText}")`);
  const dup = await egress(sos);
  check(dup.json?.status === 'duplicate' && dup.json.ack_packet_b64 === first.json.ack_packet_b64, 'reenvío → duplicate con el mismo ACK');
  const upd = await egress(update);
  check(upd.status === 200, `UPDATE → ${upd.status}`);
  const tampered = Buffer.from(sos); tampered[28] ^= 1;
  check((await egress(tampered)).status === 401, 'paquete alterado → 401');
}

await new Promise((r) => setTimeout(r, 500)); // deja que el agente termine de avisar
const box = await post('/v1/mailbox/poll', { queries: [{ sender_id: user.senderId, incident_ids: [incidentId] }], cursor: null, limit: 50 });
check(box.status === 200, `buzón → ${box.status}, ${box.json?.messages?.length ?? 0} mensaje(s)`);
for (const m of box.json?.messages ?? []) {
  const p = decodePacket(Buffer.from(m.packet_b64, 'base64'));
  console.log(`        ${m.id} tipo ${m.msg_type} seq ${p.seq}${m.msg_type === MSG.ACK ? ` ACK código ${p.category} "${p.publicText}"` : ''}`);
}
console.log(failures ? `\n${failures} comprobación(es) fallaron` : '\nTodo correcto');
process.exit(failures ? 1 : 0);
