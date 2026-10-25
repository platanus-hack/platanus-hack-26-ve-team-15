#!/usr/bin/env node
// Emula a un teléfono sin internet que consulta a la IA (CMD `preguntar_ia`) contra un servidor Meshy:
// registra al usuario sintético, abre un incidente, envía el CMD sellado como lo haría el egress y espera el
// CMD_RESULT en el buzón, que abre con la llave del usuario.
//
//   node scripts/ask-vector.mjs [--url http://localhost:8080] [--q "¿Cómo hago un torniquete?"] [--wait 60]
//
// El servidor necesita FEATURE_ASK_AI=true y ANTHROPIC_API_KEY (más ANTHROPIC_BASE_URL si usa un proxy).
import { createHash, randomInt, sign } from 'node:crypto';
import { MSG, decodePacket, encodePacket, verifyPacket } from '../src/codec.js';
import { seal, sealKeypairFromSeed, unseal } from '../src/crypto.js';
import { ed25519FromLabel, packetFor } from './synthetic.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const url = opt('url', process.env.BALIZA_URL || 'http://localhost:8080').replace(/\/$/, '');
const question = opt('q', '¿Qué hago si alguien se desmaya?');
const waitS = Number(opt('wait', '60'));
const label = opt('label', 'baliza-ask-vector');
const STATUS = ['ok', 'rechazado', 'error', 'función desactivada'];

const post = async (path, body, headers = {}) => {
  const res = await fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* no JSON */ }
  return { status: res.status, json, text };
};
const fail = (msg) => { console.error(` FAIL  ${msg}`); process.exit(1); };

const user = ed25519FromLabel(label);
const sealKp = sealKeypairFromSeed(createHash('sha256').update(`${label}:seal`).digest());

// 1. Registro (contrato §6)
const regBody = JSON.stringify({ display_name: 'Usuario Demo IA', sign_pk_b64: user.signPk.toString('base64'),
  seal_pk_b64: sealKp.publicKey.toString('base64'), contacts: [{ index: 0, name: 'Contacto Demo', channels: { email: 'contacto@example.com' } }] });
const reg = await post('/v1/users', regBody, {
  'x-baliza-pubkey': user.signPk.toString('base64'),
  'x-baliza-signature': sign(null, createHash('sha256').update(regBody).digest(), user.privateKey).toString('base64'),
});
if (reg.status !== 201) fail(`POST /v1/users → ${reg.status} ${reg.text}`);
const serverSignPk = Buffer.from(reg.json.server.sign_pk_b64, 'base64');
const serverSealPk = Buffer.from(reg.json.server.seal_pk_b64, 'base64');
console.log(`Servidor: ${url}   usuario sintético ${user.senderId}`);

// 2. Un incidente abierto (SOS), para que el CMD viaje dentro de él como en la app
const now = Math.floor(Date.now() / 1000);
const { sos, incident } = packetFor({ user, serverSealPk, now, seal });
const egress = (packet) => post('/v1/egress', { packet_b64: packet.toString('base64'), rx: { envelope_ttl: 5, egress_id: 'ask-vector', rx_at: now } });
const sosRes = await egress(sos);
if (sosRes.status !== 200) fail(`SOS → ${sosRes.status} ${sosRes.text}`);

// 3. El CMD preguntar_ia, sellado al servidor
const ref = randomInt(1, 65536);
const plaintext = Buffer.from(JSON.stringify({ cmd: 'preguntar_ia', ref, args: { q: question } }));
const cmd = encodePacket({ msgType: MSG.CMD, incidentId: incident, seq: 3, timestamp: now + 1, signer: user, blob: seal(plaintext, serverSealPk) });
const started = Date.now();
const res = await egress(cmd);
if (res.status !== 200) fail(`CMD → ${res.status} ${res.text}`);
const ack = decodePacket(Buffer.from(res.json.ack_packet_b64, 'base64'));
if (!verifyPacket(ack, serverSignPk)) fail('el ACK no está firmado por el servidor');
console.log(`  ok   CMD (${plaintext.length} B de plaintext, ref ${ref}) → ACK código ${ack.category}: "${ack.publicText}"`);

// 4. Esperar el CMD_RESULT en el buzón (lo que haría el egress cada pocos segundos)
const poll = async () => {
  const box = await post('/v1/mailbox/poll', { queries: [{ sender_id: user.senderId, incident_ids: [incident] }] });
  for (const m of box.json?.messages ?? []) {
    if (m.msg_type !== MSG.CMD_RESULT) continue;
    const p = decodePacket(Buffer.from(m.packet_b64, 'base64'));
    const pt = unseal(p.sealedBlob, sealKp.publicKey, sealKp.privateKey);
    if (verifyPacket(p, serverSignPk) && pt && pt.readUInt16BE(0) === ref) return { status: pt[2], text: pt.subarray(3).toString('utf8'), bytes: pt.length };
  }
  return null;
};
for (let waited = 0; waited <= waitS; waited += 2) {
  const result = await poll();
  if (result) {
    console.log(`  ${result.status === 0 ? 'ok ' : 'FAIL'}  CMD_RESULT tras ${Date.now() - started} ms: status ${result.status} (${STATUS[result.status] ?? '?'}), ${result.bytes} B`);
    console.log(`\n  ${result.text}\n`);
    process.exit(result.status === 0 ? 0 : 1);
  }
  await new Promise((r) => setTimeout(r, 2000));
}
fail(`sin CMD_RESULT tras ${waitS} s`);
