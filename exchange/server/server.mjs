// Local entrypoint: node exchange/server/server.mjs (from the repository root,
// after `npm ci` and the native Wasm/prover builds). See README.md.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { prover } from '../../tests/actor.mjs';
import { childEnv, createActors } from './actors.mjs';
import { createApp } from './app.mjs';
import { loadConfig, TESTNET_DIR } from './config.mjs';
import { Coordinator } from './coordinator.mjs';
import { createMarketData } from './market-data.mjs';
import { createLocalPoolProver } from './local-pool-prover.mjs';
import { SessionStore } from './store.mjs';
import { codeHashOf, connectTestnet, takeCredentials } from './testnet.mjs';
import { safeMessage } from './util.mjs';
import { KeeperWorker } from './worker.mjs';

const log = (line) => console.log(new Date().toISOString() + ' ' + line);

async function main() {
  const config = loadConfig();
  for (const forbidden of [TESTNET_DIR, config.provingDir]) {
    assert.notEqual(resolve(config.sessionDir), resolve(forbidden), 'XYTHUM_SESSION_DIR must be a dedicated directory');
  }
  for (const file of ['open.pk', 'close.pk', 'liquidation.pk']) {
    assert.ok(existsSync(join(config.provingDir, file)), 'missing public proving key ' + file);
  }
  // Hosted: role credentials come only from runtime variables or a mounted
  // file, never the local .env. They are loaded, and every secret variable
  // and the invite deleted from process.env, before any child process starts.
  const credentials = takeCredentials({ hosted: config.hosted, env: process.env });
  // Re-derive the verifying keys from the existing proving keys and pin them.
  // Hosted, the native prover also gets only the minimal child environment.
  const keys = prover('keys', config.provingDir, undefined, config.hosted ? { env: childEnv() } : {});
  for (const kind of ['open', 'liquidation', 'close']) {
    assert.equal(keys[kind + '_vk_sha256'], config.fingerprints[kind], kind + ' verifying key fingerprint differs from the pin');
  }
  const wasm = await readFile(config.marketWasm);
  const wasmSha = createHash('sha256').update(wasm).digest('hex');
  if (config.marketWasmSha256) assert.equal(wasmSha, config.marketWasmSha256, 'market Wasm differs from XYTHUM_MARKET_WASM_SHA256');

  const testnet = await connectTestnet({ credentials });
  const store = await new SessionStore(config.sessionDir).open();
  const actors = createActors({
    keeperSecrets: testnet.keeperSecrets, keeperIds: testnet.ids.keepers,
    rpcUrl: testnet.rpcUrl, provingDir: config.provingDir, keeperDir: join(config.sessionDir, 'keeper'),
  });
  // Fail fast if the keeper directory cannot be restricted to this user.
  await actors.prepare();
  const coordinator = new Coordinator({
    marketData: createMarketData(),
    config, store, chain: testnet.chain, chainId: 'testnet', rpcUrl: testnet.rpcUrl, ids: testnet.ids,
    keeperAckKeys: testnet.keeperAckKeys, keeperEncryptionKeys: testnet.keeperEncryptionKeys,
    marketDeployKey: testnet.marketDeployKey,
    vks: { open_vk: keys.open_vk, liquidation_vk: keys.liquidation_vk, close_vk: keys.close_vk },
    fingerprints: config.fingerprints, marketWasm: wasm, marketCodeHash: codeHashOf(wasm),
    actors,
  });
  const worker = new KeeperWorker({ coordinator, intervalMs: config.keeperPollMs, log });
  const server = createServer(createApp({ coordinator, config, poolProver: createLocalPoolProver(config), log }));
  // Session setup waits for several final transactions while the client waits.
  server.requestTimeout = 15 * 60_000;
  server.headersTimeout = 60_000;
  await new Promise((done, fail) => server.once('error', fail).listen(config.port, config.host, done));
  worker.start();
  log('Quiet Margin session coordinator' + (config.hosted ? ' (hosted, invite required)' : '') + ' on http://'
    + (config.host.includes(':') ? '[' + config.host + ']' : config.host) + ':' + config.port + ' (testnet, market Wasm ' + wasmSha.slice(0, 12) + ', ' + store.size + '/'
    + config.sessionQuota + ' sessions)');
  if (config.sessionQuota === 0) log('session creation disabled: set XYTHUM_SESSION_QUOTA');

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    log('shutting down');
    server.close();
    await worker.stop();
    await store.flush();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  log('startup failed: ' + safeMessage(error));
  process.exitCode = 1;
});
