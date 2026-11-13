import { ed25519 } from '@noble/curves/ed25519.js';
import { isAccountId, isEd25519PublicKey } from './api.js';
import { concat, equalBytes, fromBase58, fromBase64, sha256, subtle, toBase64, toHex, utf8 } from './bytes.js';
import { storedSigner, verifyEd25519 } from './signer.js';
import { indexedDbBackend, Store } from './store.js';
import { nep413Digest, unlockAuthorization } from './wallet-messages.js';

const PKCS8 = Uint8Array.from([0x30, 0x2e, 2, 1, 0, 0x30, 5, 6, 3, 0x2b, 0x65, 0x70, 4, 0x22, 4, 0x20]);

export async function verifyWalletSignature(wallet, accountId, authorization) {
  const result = await wallet.signMessage({ ...authorization, network: 'testnet', signerId: accountId });
  if (!isAccountId(accountId) || result?.accountId !== accountId || !isEd25519PublicKey(result.publicKey)) {
    throw new Error('The wallet signed with a different account or an unsupported key.');
  }
  const signature = fromBase64(result.signature, 64);
  const ownerKey = fromBase58(result.publicKey.slice('ed25519:'.length));
  if (toBase64(signature) !== result.signature
    || !verifyEd25519(signature, await nep413Digest(authorization), ownerKey)) {
    signature.fill(0);
    throw new Error('The wallet signature did not match the request.');
  }
  return { accountId, publicKey: result.publicKey, signature };
}

export async function unlockConnectedTrader(wallet, accountId, origin, { backend } = {}) {
  const authorization = await unlockAuthorization(origin, accountId);
  const verified = await verifyWalletSignature(wallet, accountId, authorization);
  const label = utf8('quiet-margin:connected-trader:v1:' + origin + ':' + accountId);
  const fingerprint = toHex(await sha256(label)).slice(0, 32);
  let publicKey;
  let privateKey;
  try {
    const material = await subtle().importKey('raw', verified.signature, 'HKDF', false, ['deriveBits']);
    const seed = new Uint8Array(await subtle().deriveBits({
      name: 'HKDF', hash: 'SHA-256', salt: utf8('quiet-margin:trader-seed:v1'), info: label,
    }, material, 256));
    const encoded = concat(PKCS8, seed);
    try {
      publicKey = ed25519.getPublicKey(seed);
      privateKey = await subtle().importKey('pkcs8', encoded, 'Ed25519', false, ['sign']);
    } finally {
      seed.fill(0);
      encoded.fill(0);
    }
  } finally {
    verified.signature.fill(0);
  }
  const store = new Store(backend ?? indexedDbBackend('quiet-margin-connected-v1-' + fingerprint));
  await store.putIfAbsent('signer', { kind: 'webcrypto', privateKey, publicKey });
  const record = await store.get('signer');
  if (record?.kind !== 'webcrypto' || record.privateKey?.extractable !== false
    || !(record.publicKey instanceof Uint8Array) || !equalBytes(record.publicKey, publicKey)) {
    throw new Error('This wallet signed with a different key. Use the key that first opened the trading wallet.');
  }
  const signer = await storedSigner(store);
  const probe = utf8('quiet-margin:connected-key-check:v1');
  if (!verifyEd25519(await signer.sign(probe), probe, publicKey)) {
    throw new Error('The browser could not recover the trading key from storage.');
  }
  return { store, signer };
}
