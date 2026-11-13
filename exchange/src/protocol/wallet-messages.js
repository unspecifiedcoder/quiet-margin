import { concat, le32, sha256, utf8 } from './bytes.js';

const TAG = 2 ** 31 + 413;
export const FAUCET_GRANT_CENTS = 60_000;
export const FAUCET_WINDOW_MS = 5 * 60_000;

function field(text) {
  const bytes = utf8(text);
  return concat(le32(bytes.length), bytes);
}

export function nep413Digest({ message, nonce, recipient, callbackUrl }) {
  if (nonce.length !== 32) throw new Error('Invalid wallet nonce');
  const callback = callbackUrl
    ? concat(Uint8Array.of(1), field(callbackUrl))
    : Uint8Array.of(0);
  return sha256(le32(TAG), field(message), nonce, field(recipient), callback);
}

async function authorization(origin, domain, lines) {
  const recipient = new URL(origin).host;
  const message = [...lines, 'Site: ' + origin, 'Network: NEAR testnet'].join('\n');
  const nonce = await sha256(field(domain), field(message));
  return { message, nonce, recipient };
}

export function unlockAuthorization(origin, accountId) {
  return authorization(origin, 'quiet-margin:trader-unlock:v1', [
    'Unlock your Quiet Margin trading wallet',
    'Account: ' + accountId,
    'This signature creates or recovers a separate trading key on this site.',
    'No transaction will be submitted. Keep this signature private.',
  ]);
}

export function faucetAuthorization(origin, accountId, traderPublicKey, expiresAt) {
  return authorization(origin, 'quiet-margin:faucet-claim:v1', [
    'Claim 600 mUSDC for Quiet Margin',
    'Account: ' + accountId,
    'Trading key: ' + traderPublicKey,
    'Expires: ' + new Date(expiresAt).toISOString(),
    'One grant per testnet account. The operator verifies this signature.',
  ]);
}
