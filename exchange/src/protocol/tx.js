// NEAR transaction construction with the official @near-js primitives. The
// browser signs `sha256(borsh(Transaction))` with its own key; the returned
// bytes are the Borsh `SignedTransaction` broadcast to RPC.

import { KeyType, PublicKey } from '@near-js/crypto';
import { actionCreators, createTransaction, encodeTransaction, Signature, SignedTransaction } from '@near-js/transactions';
import { fromBase58, sha256, toBase58, toBase64, utf8 } from './bytes.js';

export const TGAS = 1_000_000_000_000n;
/** Same budget the recorded testnet demo used for every trader call. */
export const CALL_GAS = 80n * TGAS;
export const ONE_YOCTO = 1n;

export function functionCall(method, args, { gas = CALL_GAS, deposit = 0n } = {}) {
  return actionCreators.functionCall(method, utf8(JSON.stringify(args)), gas, deposit);
}

/**
 * Builds and signs one transaction. Returns the transaction hash (Base58)
 * and the signed Borsh bytes (Base64), so the caller can journal both before
 * broadcasting and later re-send exactly the same bytes.
 */
export async function signTransaction({ signer, signerId, receiverId, nonce, blockHash, actions }) {
  const publicKey = PublicKey.fromString(signer.publicKey);
  const tx = createTransaction(signerId, publicKey, receiverId, BigInt(nonce), actions, fromBase58(blockHash));
  const encoded = encodeTransaction(tx);
  const digest = await sha256(encoded);
  const signature = await signer.sign(digest);
  if (signature.length !== 64) throw new Error('signer returned a malformed signature');
  const signed = new SignedTransaction({
    transaction: tx,
    signature: new Signature({ keyType: KeyType.ED25519, data: signature }),
  });
  return { hash: toBase58(digest), signedTx: toBase64(signed.encode()) };
}
