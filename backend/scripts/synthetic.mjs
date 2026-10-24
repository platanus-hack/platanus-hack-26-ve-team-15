// Ayudas para scripts: usuario sintético (misma derivación que docs/examples/generate-examples.mjs)
// y paquetes SOS/UPDATE nuevos con blobs sellados de verdad.
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { MSG, encodePacket, senderIdOf } from '../src/codec.js';

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export function ed25519FromLabel(label) {
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, createHash('sha256').update(label).digest()]), format: 'der', type: 'pkcs8' });
  const signPk = Buffer.from(createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(-32));
  return { privateKey, signPk, senderId: senderIdOf(signPk) };
}

const plaintext = (note, { mask = 0b11, channels = 0b011, rxCursor = 0 } = {}) => {
  const head = Buffer.alloc(7);
  head.writeUInt32BE(mask, 0);
  head[4] = channels;
  head.writeUInt16BE(rxCursor, 5);
  return Buffer.concat([head, Buffer.from(note, 'utf8')]);
};

export function packetFor({ user, serverSealPk, now, seal }) {
  const incident = createHash('sha256').update(`incident-${now}`).digest().subarray(0, 8).toString('hex');
  const common = { incidentId: incident, category: 1, severity: 3, lat: 1049700, lon: -6685300, accuracyM: 12, locationAge: 4, timestamp: now, signer: user };
  const sos = encodePacket({ ...common, msgType: MSG.SOS, seq: 1, publicText: 'SOS medico, necesito ayuda',
    blob: seal(plaintext('Persona inconsciente en la plaza. Tel de prueba +58 000-0000000'), serverSealPk) });
  const update = encodePacket({ ...common, msgType: MSG.UPDATE, seq: 2, lat: 1049720, lon: -6685315, locationAge: 1, timestamp: now + 1,
    publicText: 'Sigo aqui, ya respira', blob: seal(plaintext('Respira pero sigue sin hablar'), serverSealPk) });
  return { sos, update, incident };
}
