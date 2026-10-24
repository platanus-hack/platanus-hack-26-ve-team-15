// Interop vectors for the sealed_blob (libsodium crypto_box_seal), synthetic keys and plaintexts.
//   npm i libsodium-wrappers            (once, anywhere on NODE_PATH)
//   node docs/examples/sealedbox.mjs generate > docs/examples/sealedbox-vectors.json
//   node docs/examples/sealedbox.mjs open <file.json>   # opens boxes sealed by another implementation
// "generate" makes boxes with libsodium so the Kotlin app can prove it opens them.
// "open" takes {recipient_pk_hex, recipient_sk_hex, boxes:[{sealed_hex, plaintext_hex}]} produced by
// the app's SealedBox.seal and proves libsodium (the backend) can open them.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

// createRequire honours NODE_PATH, so the package can live outside the repo.
const sodium = createRequire(import.meta.url)('libsodium-wrappers');

await sodium.ready;
const hex = (u8) => Buffer.from(u8).toString('hex');
const unhex = (s) => new Uint8Array(Buffer.from(s, 'hex'));

const mode = process.argv[2];
if (mode === 'generate') {
  const seed = createHash('sha256').update('baliza-synthetic-seal-recipient').digest();
  const kp = sodium.crypto_box_seed_keypair(new Uint8Array(seed));
  const plaintexts = [
    Buffer.alloc(0),
    Buffer.from('x'),
    Buffer.from('Persona inconsciente en la plaza. Tel de prueba +58 000-0000000', 'utf8'),
    Buffer.alloc(204, 0x5a), // largest SOS/UPDATE plaintext (contrato.md §2.1)
    Buffer.alloc(264, 0xc3), // largest MSG_OUT/MSG_IN/CMD/CMD_RESULT plaintext
  ];
  const boxes = plaintexts.map((p) => {
    const sealed = sodium.crypto_box_seal(new Uint8Array(p), kp.publicKey);
    return { plaintext_hex: p.toString('hex'), sealed_hex: hex(sealed), sealed_bytes: sealed.length };
  });
  console.log(JSON.stringify({
    note: 'Synthetic. Made by libsodium crypto_box_seal; the overhead is 48 bytes.',
    recipient_pk_hex: hex(kp.publicKey),
    recipient_sk_hex: hex(kp.privateKey),
    boxes,
  }, null, 2));
} else if (mode === 'open') {
  const file = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  const pk = unhex(file.recipient_pk_hex);
  const sk = unhex(file.recipient_sk_hex);
  let bad = 0;
  for (const [i, b] of file.boxes.entries()) {
    try {
      const opened = sodium.crypto_box_seal_open(unhex(b.sealed_hex), pk, sk);
      const ok = hex(opened) === b.plaintext_hex;
      console.log(`box ${i}: ${ok ? 'OK' : 'MISMATCH'} (${opened.length} B)`);
      if (!ok) bad++;
    } catch (e) {
      console.log(`box ${i}: FAILED to open (${e.message})`);
      bad++;
    }
  }
  process.exit(bad ? 1 : 0);
} else {
  console.error('usage: sealedbox.mjs generate | open <file.json>');
  process.exit(2);
}
