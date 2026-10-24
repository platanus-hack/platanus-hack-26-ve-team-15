// Sellado (crypto_box_seal de libsodium) y llaves del servidor (contrato §3.4, §3.5).
import { createHmac, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import sodium from 'libsodium-wrappers';
import { senderIdOf } from './codec.js';

await sodium.ready;

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export const generateSealKeypair = () => {
  const kp = sodium.crypto_box_keypair();
  return { publicKey: Buffer.from(kp.publicKey), privateKey: Buffer.from(kp.privateKey) };
};

/** Par X25519 determinista a partir de una semilla de 32 B (para scripts y pruebas). */
export const sealKeypairFromSeed = (seed) => {
  const kp = sodium.crypto_box_seed_keypair(seed);
  return { publicKey: Buffer.from(kp.publicKey), privateKey: Buffer.from(kp.privateKey) };
};

export const seal = (plaintext, sealPk) => Buffer.from(sodium.crypto_box_seal(plaintext, sealPk));

/** Devuelve el plaintext o `null` si el blob no abre (p. ej. relleno de los vectores). */
export function unseal(blob, sealPk, sealSk) {
  try {
    return Buffer.from(sodium.crypto_box_seal_open(blob, sealPk, sealSk));
  } catch {
    return null;
  }
}

const signerFromSeed = (seed) => {
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(-32);
  return { privateKey, signPk: Buffer.from(publicKey), senderId: senderIdOf(publicKey) };
};

/**
 * Llaves del servidor: Ed25519 (firma) y X25519 (sellado). Se leen de `env`
 * (BALIZA_SIGN_SEED_HEX, BALIZA_SEAL_SK_HEX); si faltan, se generan una vez en `keyFile`
 * (fuera del repo, `backend/data/`) y se reutilizan entre reinicios.
 */
export function loadServerKeys({ env = process.env, keyFile } = {}) {
  let stored = {};
  if (!env.BALIZA_SIGN_SEED_HEX || !env.BALIZA_SEAL_SK_HEX) {
    if (keyFile && existsSync(keyFile)) stored = JSON.parse(readFileSync(keyFile, 'utf8'));
  }
  let signSeedHex = env.BALIZA_SIGN_SEED_HEX || stored.sign_seed_hex;
  let sealSkHex = env.BALIZA_SEAL_SK_HEX || stored.seal_sk_hex;
  if (!signSeedHex || !sealSkHex) {
    const { privateKey } = generateKeyPairSync('ed25519');
    signSeedHex = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('hex');
    sealSkHex = Buffer.from(sodium.randombytes_buf(32)).toString('hex');
    if (keyFile) {
      mkdirSync(dirname(keyFile), { recursive: true });
      writeFileSync(keyFile, JSON.stringify({ sign_seed_hex: signSeedHex, seal_sk_hex: sealSkHex }), { mode: 0o600 });
    }
  }
  const signer = signerFromSeed(Buffer.from(signSeedHex, 'hex'));
  const sealSk = Buffer.from(sealSkHex, 'hex');
  const sealPk = Buffer.from(sodium.crypto_scalarmult_base(sealSk));
  // Secreto para los enlaces de respuesta de contactos; se deriva de la semilla, nunca se guarda aparte.
  const replySecret = createHmac('sha256', Buffer.from(signSeedHex, 'hex')).update('baliza-reply-token-v1').digest();
  return { ...signer, sealPk, sealSk, replySecret, keyId: env.BALIZA_KEY_ID || 'k1' };
}
