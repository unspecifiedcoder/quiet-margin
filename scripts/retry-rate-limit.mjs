import { setTimeout as delay } from 'node:timers/promises';

export const TESTNET_ARCHIVAL_FALLBACK = 'https://archival-rpc.testnet.near.org';

function isRateLimited(error) {
  const code = error.data?.code ?? error.code;
  return code === -429 || code === 429 || error.status === 429 || /\bHTTP 429\b/.test(error.message);
}

export async function retryRateLimit(read, fallback) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      try {
        return await read();
      } catch (error) {
        if (!fallback || !isRateLimited(error)) throw error;
        return await fallback();
      }
    } catch (error) {
      if (!isRateLimited(error) || attempt === 4) throw error;
      await delay(4_000 * 2 ** attempt);
    }
  }
}
