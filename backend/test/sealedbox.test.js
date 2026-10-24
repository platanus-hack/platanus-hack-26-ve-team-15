// Conformidad del sellado (contrato §3.5): el backend abre las cajas generadas con libsodium en
// docs/examples/sealedbox-vectors.json y sus propias cajas llevan el sobrecarga de 48 B.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SEAL_OVERHEAD } from '../src/codec.js';
import { generateSealKeypair, seal, unseal } from '../src/crypto.js';

const vectors = JSON.parse(readFileSync(fileURLToPath(new URL('../../docs/examples/sealedbox-vectors.json', import.meta.url)), 'utf8'));
const pk = Buffer.from(vectors.recipient_pk_hex, 'hex');
const sk = Buffer.from(vectors.recipient_sk_hex, 'hex');

test('hay vectores y cubren los tamaños límite del contrato (0, 1, 204 y 264 B de plaintext)', () => {
  const sizes = vectors.boxes.map((b) => b.plaintext_hex.length / 2);
  for (const n of [0, 1, 204, 264]) assert.ok(sizes.includes(n), `falta el caso de ${n} B`);
});

vectors.boxes.forEach((box, i) => {
  test(`vector de sellado #${i} (${box.plaintext_hex.length / 2} B): se abre y coincide el plaintext`, () => {
    const sealed = Buffer.from(box.sealed_hex, 'hex');
    assert.equal(sealed.length, box.plaintext_hex.length / 2 + SEAL_OVERHEAD);
    const opened = unseal(sealed, pk, sk);
    assert.ok(opened, 'crypto_box_seal_open debe abrirla');
    assert.equal(opened.toString('hex'), box.plaintext_hex);
  });
});

test('una caja alterada, o abierta con otra llave, no abre', () => {
  const sealed = Buffer.from(vectors.boxes[2].sealed_hex, 'hex');
  const tampered = Buffer.from(sealed);
  tampered[tampered.length - 1] ^= 1;
  assert.equal(unseal(tampered, pk, sk), null);
  const other = generateSealKeypair();
  assert.equal(unseal(sealed, other.publicKey, other.privateKey), null);
});

test('las cajas que sella el backend miden plaintext + 48 B y las abre el destinatario', () => {
  const kp = generateSealKeypair();
  for (const n of [0, 1, 204, 264]) {
    const pt = Buffer.alloc(n, 0x41);
    const box = seal(pt, kp.publicKey);
    assert.equal(box.length, n + SEAL_OVERHEAD);
    assert.ok(unseal(box, kp.publicKey, kp.privateKey).equals(pt));
  }
});
