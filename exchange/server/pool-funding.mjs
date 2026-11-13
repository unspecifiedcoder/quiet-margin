import { createHash } from 'node:crypto';
import { isAccountId, isEd25519PublicKey } from '../src/protocol/api.js';
import { fromBase58, fromBase64, toBase64, toHex } from '../src/protocol/bytes.js';
import { verifyEd25519 } from '../src/protocol/signer.js';
import { nep413Digest, poolFundingAuthorization, FAUCET_WINDOW_MS } from '../src/protocol/wallet-messages.js';
import { HttpError, KeyedSerializer } from './util.mjs';

export function createPoolFunding({ chain, sponsor, token, origin, store, quota, now = Date.now }) {
  const serial = new KeyedSerializer();
  const gas = 70_000_000_000_000n;
  const invalid = () => new HttpError(401, 'invalid_wallet_proof', 'Approve the test funding request with your connected wallet.');
  return async (request) => {
    const { account, publicKey, traderKey, signature, expiresAt } = request ?? {};
    if (!isAccountId(account) || account === sponsor.accountId || !isEd25519PublicKey(publicKey)
      || !isEd25519PublicKey(traderKey) || publicKey === traderKey || !Number.isSafeInteger(expiresAt)
      || expiresAt <= now() || expiresAt > now() + FAUCET_WINDOW_MS || typeof signature !== 'string') throw invalid();
    let signed, owner, privateAccount;
    try {
      signed = fromBase64(signature, 64);
      owner = fromBase58(publicKey.slice(8));
      privateAccount = toHex(fromBase58(traderKey.slice(8)));
    } catch { throw invalid(); }
    const digest = await nep413Digest(await poolFundingAuthorization(origin, account, traderKey, expiresAt));
    if (toBase64(signed) !== signature || !verifyEd25519(signed, digest, owner)) throw invalid();
    const keyState = await chain.provider.query({ request_type: 'view_access_key', account_id: account,
      public_key: publicKey, finality: 'final' }).catch((error) => {
      if (/UNKNOWN_ACCOUNT|UNKNOWN_ACCESS_KEY|does not exist/i.test(error.message)) throw invalid();
      throw error;
    });
    if (keyState.permission !== 'FullAccess') throw invalid();

    const key = 's-' + createHash('sha256').update('quiet-margin:pool-funding:v1:' + account).digest('hex').slice(0, 24);
    return serial.run('sponsor', async () => {
      let claim = store.get(key);
      if (claim && claim.privateAccount !== privateAccount) {
        throw new HttpError(409, 'already_claimed', 'This wallet already claimed test funding with another private signer.');
      }
      if (claim?.funded) return { funded: true };
      if (!claim) {
        if (store.size >= quota) throw new HttpError(429, 'quota_exhausted', 'The test funding allocation is full.');
        claim = { key, privateAccount };
        await store.save(claim);
      }

      // Registration is idempotent. Funding moves NEAR and tokens in separate
      // receipts, so persist each signed transaction before broadcasting.
      const args = { account_id: account, registration_only: true };
      if (!claim.registration) await chain.callOnce(sponsor, token, 'storage_deposit', args, gas, 10n ** 22n, claim, 'registration', store);
      if (!claim.publicGas) await chain.transferOnce(sponsor, account, 3n * 10n ** 22n, claim, 'publicGas', store);
      if (!claim.privateGas) await chain.transferOnce(sponsor, privateAccount, 35n * 10n ** 22n, claim, 'privateGas', store);
      if (!claim.tokens) await chain.callOnce(sponsor, token, 'ft_transfer', {
        receiver_id: account, amount: '10000',
      }, gas, 1n, claim, 'tokens', store);
      claim.funded = true;
      await store.save(claim);
      return { funded: true };
    });
  };
}
