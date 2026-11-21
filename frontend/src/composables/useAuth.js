import { ensureTweetNacl } from '../utils/externalDeps.js';

const toBase64Url = bytes => {
  let raw = '';
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
};

export function generateRealityKeys(targetWindow = globalThis.window) {
  const nacl = targetWindow?.nacl;
  if (!nacl?.box?.keyPair) throw new Error('TweetNaCl is not loaded');
  const keypair = nacl.box.keyPair();
  return {
    privateKey: toBase64Url(keypair.secretKey),
    publicKey: toBase64Url(keypair.publicKey),
    shortId: crypto.randomUUID().replace(/-/g, '').substring(0, 16),
  };
}

export function ensureRealityKeysReady(options = {}) {
  return ensureTweetNacl(options);
}

export async function generateRealityKeysAsync(options = {}) {
  await ensureTweetNacl(options);
  return generateRealityKeys(options.win ?? globalThis.window);
}

export function generateSs2022Password(method = '2022-blake3-aes-256-gcm') {
  const key = new Uint8Array(method.includes('128') ? 16 : 32);
  crypto.getRandomValues(key);
  let raw = '';
  for (const byte of key) raw += String.fromCharCode(byte);
  return btoa(raw);
}
