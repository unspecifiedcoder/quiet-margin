// Real-browser smoke: proves open (uncompressed key) and close (compressed
// key) inside a module Web Worker in headless Chrome/Edge.
//
//   node prover/browser/worker-smoke.mjs [pkg_dir]
//
// Serves the wasm package, fresh synthetic keys (generated into the OS temp
// dir, deleted afterwards), and a test page from 127.0.0.1 only. Set
// XYTHUM_BROWSER to the browser executable if it is not found automatically.
// Requires the native release binaries and the wasm package, as smoke.mjs.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const prover = resolve(here, '..');
const pkgDir = resolve(process.argv[2] ?? join(prover, 'target', 'browser', 'pkg'));
const exe = process.platform === 'win32' ? '.exe' : '';
const bin = (name) => join(prover, 'target', 'release', name + exe);

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args[0]} failed: ${r.stderr.trim()}`);
  return JSON.parse(r.stdout);
}

function findBrowser() {
  const candidates = [
    process.env.XYTHUM_BROWSER,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  const found = candidates.find((c) => c && existsSync(c));
  if (!found) throw new Error('no Chrome/Edge found; set XYTHUM_BROWSER');
  return found;
}

const b64 = (byte) => Buffer.alloc(32, byte).toString('base64');
const OPENING = { context: b64(0x11), size_lots: 10, entry_ticks: 10_000, margin_cents: 50_000, blinder: b64(0xa5) };

const WORKER = `
import init, { prove_open, prove_close, key_info } from '/pkg/xythum_prover.js';
self.onmessage = async ({ data }) => {
  try {
    const wasm = await init({ module_or_path: '/pkg/xythum_prover_bg.wasm' });
    const pk = new Uint8Array(await (await fetch(data.key)).arrayBuffer());
    const info = JSON.parse(key_info(pk));
    const t0 = performance.now();
    const out = (data.kind === 'open' ? prove_open : prove_close)(pk, data.fingerprint, JSON.stringify(data.input));
    self.postMessage({ ok: true, info, out: JSON.parse(out), call_ms: Math.round(performance.now() - t0),
      wasm_memory: wasm.memory.buffer.byteLength, isSecureContext: self.isSecureContext });
  } catch (e) {
    self.postMessage({ ok: false, error: String(e && e.message || e) });
  }
};`;

const PAGE = (cases) => `<!doctype html><meta charset="utf-8"><script type="module">
const cases = ${JSON.stringify(cases)};
const results = [];
for (const c of cases) {
  const w = new Worker('/worker.js', { type: 'module' });
  results.push(await new Promise((res) => { w.onmessage = (e) => res({ case: c.name, ...e.data }); w.onerror = (e) => res({ case: c.name, ok: false, error: e.message }); w.postMessage(c); }));
  w.terminate();
}
await fetch('/result', { method: 'POST', body: JSON.stringify(results) });
</script>`;

const work = mkdtempSync(join(tmpdir(), 'xythum-worker-smoke-'));
let browser;
let server;
try {
  const keys = join(work, 'keys');
  const packed = join(work, 'packed');
  const setup = run(bin('xythum-prover'), ['setup', keys]);
  const exported = run(bin('xythum-browser-keys'), ['compress', keys, packed]);
  const cases = [
    { name: 'open/uncompressed', kind: 'open', key: '/keys/open.pk', fingerprint: setup.open_vk_sha256,
      input: { ...OPENING, quote_blinder: b64(0x3c), open_price_ticks: 10_000 } },
    { name: 'close/compressed', kind: 'close', key: '/packed/' + exported.close.file, fingerprint: setup.close_vk_sha256,
      input: { ...OPENING, round: 7, price_ticks: 9_500, funding_cents: 3 } },
  ];
  const roots = { pkg: pkgDir, keys, packed };
  const types = { '.js': 'text/javascript', '.wasm': 'application/wasm', '.html': 'text/html' };

  const result = await new Promise((resolveResult, reject) => {
    server = createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'POST' && url.pathname === '/result') {
        let body = '';
        req.on('data', (d) => (body += d));
        req.on('end', () => { res.end('ok'); resolveResult(JSON.parse(body)); });
        return;
      }
      if (url.pathname === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE(cases));
      if (url.pathname === '/worker.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end(WORKER);
      const [, root, ...rest] = url.pathname.split('/');
      const base = roots[root];
      const file = base && normalize(join(base, ...rest));
      if (!file || !file.startsWith(base + sep) || !existsSync(file)) return res.writeHead(404).end();
      res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      browser = spawn(findBrowser(), [
        '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        '--disable-extensions', '--disable-background-networking', '--disable-component-update',
        '--disable-sync', `--user-data-dir=${join(work, 'profile')}`, `http://127.0.0.1:${port}/`,
      ], { stdio: 'ignore' });
      browser.on('exit', (code) => reject(new Error(`browser exited (${code}) before reporting`)));
    });
    setTimeout(() => reject(new Error('timed out after 30 minutes')), 30 * 60 * 1000).unref();
  });

  let failed = false;
  for (const r of result) {
    if (!r.ok) { failed = true; console.log(`${r.case}: FAILED ${r.error}`); continue; }
    const fields = Object.keys(r.out).join(',');
    const expected = r.case.startsWith('open') ? 'commitment,quote_terms,proof,proving_ms' : 'commitment,proof,proving_ms,refund,bad_debt';
    if (fields !== expected) { failed = true; console.log(`${r.case}: bad fields ${fields}`); }
    console.log(`${r.case}: ${r.info.format} key ${(r.info.bytes / 2 ** 20).toFixed(1)} MiB, proving_ms ${r.out.proving_ms}, ` +
      `call ${r.call_ms} ms, wasm memory ${(r.wasm_memory / 2 ** 20).toFixed(1)} MiB, secure context ${r.isSecureContext}`);
  }
  console.log(failed ? 'worker smoke: FAILED' : 'worker smoke: OK');
  process.exitCode = failed ? 1 : 0;
} finally {
  browser?.removeAllListeners('exit');
  browser?.kill();
  server?.close();
  await new Promise((r) => setTimeout(r, 1000));
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
