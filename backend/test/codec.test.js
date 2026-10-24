import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  MSG, MAX_INNER_BYTES, PacketError, decodePacket, encodePacket, senderIdOf, truncateUtf8, verifyPacket,
} from '../src/codec.js';
import { ed25519FromLabel } from './helpers.js';

const examples = JSON.parse(readFileSync(fileURLToPath(new URL('../../docs/examples/examples.json', import.meta.url)), 'utf8'));
const userPk = Buffer.from(examples.keys.user.sign_pk_hex, 'hex');
const serverPk = Buffer.from(examples.keys.server.sign_pk_hex, 'hex');
const SERVER_TYPES = new Set([MSG.ACK, MSG.MSG_IN, MSG.CMD_RESULT]);

test('sender_id se deriva como SHA-256(pk)[0..8]', () => {
  assert.equal(senderIdOf(userPk), examples.keys.user.sender_id);
  assert.equal(senderIdOf(serverPk), examples.keys.server.sender_id);
});

for (const [name, vec] of Object.entries(examples.packets)) {
  test(`vector ${name}: decodifica, firma válida y tamaño anunciado`, () => {
    const packet = decodePacket(Buffer.from(vec.base64, 'base64'));
    assert.equal(packet.msgType, vec.msg_type);
    assert.equal(packet.raw.length, vec.bytes);
    assert.equal(packet.incidentId, examples.incident_id);
    const expectedPk = SERVER_TYPES.has(packet.msgType) ? serverPk : userPk;
    assert.equal(packet.senderId, senderIdOf(expectedPk));
    assert.ok(verifyPacket(packet, expectedPk), 'firma Ed25519 válida');
    assert.ok(!verifyPacket(packet, SERVER_TYPES.has(packet.msgType) ? userPk : serverPk), 'otra llave no valida');
  });
}

test('la firma no cubre el ttl (se puede reescribir sin romperla)', () => {
  const raw = Buffer.from(examples.packets.SOS.base64, 'base64');
  raw[2] = 3;
  assert.ok(verifyPacket(decodePacket(raw), userPk));
});

test('cualquier otro byte alterado invalida la firma', () => {
  const raw = Buffer.from(examples.packets.SOS.base64, 'base64');
  raw[28] ^= 1;
  assert.ok(!verifyPacket(decodePacket(raw), userPk));
});

test('campos del SOS de ejemplo', () => {
  const p = decodePacket(Buffer.from(examples.packets.SOS.base64, 'base64'));
  assert.deepEqual([p.seq, p.category, p.severity, p.lat, p.lon, p.accuracyM, p.locationAge, p.timestamp, p.ttl],
    [1, 1, 3, 1049700, -6685300, 12, 4, 1798200000, 7]);
  assert.equal(p.publicText, 'SOS medico, necesito ayuda');
});

test('el ACK de ejemplo no trae ubicación', () => {
  const p = decodePacket(Buffer.from(examples.packets.ACK.base64, 'base64'));
  assert.equal(p.lat, null);
  assert.equal(p.lon, null);
  assert.equal(p.sealedBlob.length, 0);
});

test('re-codificar el SOS con la misma llave reproduce los mismos bytes (Ed25519 es determinista)', () => {
  const signer = ed25519FromLabel('baliza-synthetic-user-1');
  const orig = decodePacket(Buffer.from(examples.packets.SOS.base64, 'base64'));
  const again = encodePacket({
    msgType: MSG.SOS, ttl: 7, incidentId: orig.incidentId, seq: 1, category: 1, severity: 3, lat: 1049700, lon: -6685300,
    accuracyM: 12, locationAge: 4, timestamp: 1798200000, publicText: orig.publicText, blob: orig.sealedBlob, signer,
  });
  assert.equal(again.toString('hex'), examples.packets.SOS.hex);
});

test('peor caso: SOS de 60 B de texto y 252 B de blob mide 418 B', () => {
  const signer = ed25519FromLabel('baliza-synthetic-user-1');
  const p = encodePacket({ msgType: MSG.SOS, incidentId: '0a68279fb49bde12', seq: 65535, timestamp: 1, publicText: 'x'.repeat(60), blob: Buffer.alloc(252, 1), signer });
  assert.equal(p.length, examples.worst_case_sos.bytes);
  assert.equal(p.length, MAX_INNER_BYTES);
  assert.equal(decodePacket(p).sealedBlob.length, 252);
});

test('rechaza paquetes malformados', () => {
  const good = Buffer.from(examples.packets.SOS.base64, 'base64');
  const bad = (buf, re) => assert.throws(() => decodePacket(buf), (e) => e instanceof PacketError && re.test(e.message));
  bad(Buffer.concat([good, Buffer.alloc(200)]), /> 418/);
  bad(good.subarray(0, 20), /too short/);
  bad(Buffer.concat([Buffer.from([2]), good.subarray(1)]), /version/);
  bad(Buffer.concat([good.subarray(0, 1), Buffer.from([9]), good.subarray(2)]), /msg_type/);
  bad(Buffer.concat([good.subarray(0, 39), Buffer.from([61]), good.subarray(40)]), /text_len/);
  bad(good.subarray(0, good.length - 1), /length mismatch|truncated/);
  bad(Buffer.concat([good.subarray(0, 14), Buffer.from([4]), good.subarray(15)]), /severity/);
});

test('truncateUtf8 no parte caracteres', () => {
  assert.equal(truncateUtf8('hola', 10), 'hola');
  assert.equal(truncateUtf8('ñandú', 2), 'ñ');
  assert.equal(Buffer.byteLength(truncateUtf8('ññññ', 5), 'utf8') <= 5, true);
});
