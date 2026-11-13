import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createApp } from './app.mjs';
import { loadConfig } from './config.mjs';
import { createMarketData } from './market-data.mjs';
import { createPoolFunding } from './pool-funding.mjs';
import { connectPoolSponsor } from './pool-sponsor.mjs';
import { SessionStore } from './store.mjs';

const origin = process.env.QUIET_POOL_ORIGIN;
const host = process.env.QUIET_POOL_HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? '8798');
const parsed = new URL(origin ?? 'http://127.0.0.1:' + port);
if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password
  || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1'))) {
  throw new Error('Set QUIET_POOL_ORIGIN to the browser-facing HTTPS origin.');
}
const config = { ...loadConfig({}), poolFundingOrigin: parsed.origin };
const coordinator = { store: { size: 0 }, marketData: createMarketData() };
let poolFunding;
let store;
if (process.env.QUIET_POOL_SPONSOR_KEY) {
  const quota = Number(process.env.QUIET_POOL_FUNDING_QUOTA ?? '6');
  if (!Number.isInteger(quota) || quota < 1 || quota > 12 || !process.env.QUIET_POOL_FUNDING_DIR) {
    throw new Error('Set an integer funding quota between 1 and 12 and a durable claims directory.');
  }
  const { chain, sponsor } = await connectPoolSponsor(process.env.QUIET_POOL_SPONSOR_ID, process.env.QUIET_POOL_SPONSOR_KEY);
  delete process.env.QUIET_POOL_SPONSOR_KEY;
  const deployment = JSON.parse(await readFile(fileURLToPath(new URL('../dist/shielded/judge-pool/config.json', import.meta.url)), 'utf8'));
  store = await new SessionStore(resolve(process.env.QUIET_POOL_FUNDING_DIR)).open();
  poolFunding = createPoolFunding({ chain, sponsor, token: deployment.token, origin: parsed.origin, store, quota });
}
const app = createApp({ coordinator, config, poolFunding });
const server = createServer((req, res) => {
  if ((req.method === 'GET' || req.method === 'HEAD') && req.url === '/') {
    res.writeHead(302, { Location: '/shielded', 'Cache-Control': 'no-store' }).end();
    return;
  }
  void app(req, res);
});
server.requestTimeout = 120_000;
server.listen(port, host, () => console.log('Quiet Margin judge app listening on port ' + port));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => { store?.close(); process.exit(0); }));
}
