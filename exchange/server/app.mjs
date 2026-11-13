// HTTP surface of the session coordinator. Logs carry only method, route name,
// status and latency: never request bodies, headers, capabilities or keys.
import { timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { INVITE_PATTERN } from './config.mjs';
import { HttpError, safeMessage } from './util.mjs';

const BODY_LIMIT = 4_096;
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
};
// The browser talks only to this origin and to the pinned testnet RPC.
export const HOSTED_RPC_ORIGIN = 'https://test.rpc.fastnear.com';
// Extra headers for the hosted build only (the Vite dev server is untouched).
// 'wasm-unsafe-eval' lets the same-origin prover Wasm compile without allowing
// JavaScript eval; the proving worker is a same-origin module script.
export const HOSTED_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self'",
  "connect-src 'self' " + HOSTED_RPC_ORIGIN,
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');
export const HOSTED_HEADERS = Object.freeze({
  'Content-Security-Policy': HOSTED_CSP,
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=31536000',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
});
const POSITION_EXPLORER_HEADERS = Object.freeze({
  ...HOSTED_HEADERS,
  'Content-Security-Policy': HOSTED_CSP.replace(
    "connect-src 'self' " + HOSTED_RPC_ORIGIN,
    "connect-src 'self' " + HOSTED_RPC_ORIGIN + ' https://archival-rpc.testnet.fastnear.com',
  ),
});
export const INVITE_HEADER = 'x-xythum-invite';
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};
export const PROVING_FILES = Object.freeze({ '/api/proving/open.pk': 'open.pk', '/api/proving/close.pk': 'close.pk' });
const POOL_PROVING_FILES = Object.freeze({ '/api/proving/pool-spend.pk': 'spend.pk', '/api/proving/pool-close.pk': 'close.pk' });

function sendJson(res, status, body, headers = {}) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    ...SECURITY_HEADERS, ...res.xythumHeaders, ...headers,
    'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store',
  });
  res.end(data);
}

async function readJson(req, limit = BODY_LIMIT) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
    throw new HttpError(415, 'content_type', 'expected application/json');
  }
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > limit) throw new HttpError(413, 'body_too_large', 'request body is too large');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'body_too_large', 'request body is too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json', 'request body must be JSON');
  }
}

async function sendFile(res, path, type, cache) {
  let info;
  try {
    info = await stat(path);
  } catch {
    return false;
  }
  if (!info.isFile()) return false;
  res.writeHead(200, { ...SECURITY_HEADERS, ...res.xythumHeaders, 'Content-Type': type, 'Content-Length': info.size, 'Cache-Control': cache });
  await new Promise((resolveStream, reject) => {
    createReadStream(path).on('error', reject).on('end', resolveStream).pipe(res);
  });
  return true;
}

// Hosted admission: the X-Xythum-Invite header must be exactly the configured
// 32-byte invite as 64 lowercase hex digits. Shape is checked first (it does
// not depend on the secret), then the bytes are compared in constant time.
export function checkInvite(header, invite) {
  if (typeof header !== 'string' || !INVITE_PATTERN.test(header)) return false;
  const given = Buffer.from(header, 'hex');
  return given.length === invite.length && timingSafeEqual(given, invite);
}

export function createApp({ coordinator, config, poolProver, poolFunding, poolKeeperAck, log = () => {} }) {
  const distRoot = resolve(config.distDir);
  const admit = (req) => {
    if (!config.hosted) return;
    if (!(config.hostedInvite instanceof Buffer) || config.hostedInvite.length !== 32) {
      throw new Error('hosted mode without a configured invite');
    }
    if (!checkInvite(req.headers[INVITE_HEADER], config.hostedInvite)) {
      throw new HttpError(401, 'invite_required', 'a valid invite is required to create a session');
    }
  };
  const routes = {
    'POST /api/pool/keeper-ack': async (req) => {
      if (!poolKeeperAck) throw new HttpError(404, 'not_found', 'Keeper acknowledgments are unavailable on this host.');
      if (req.headers.origin !== config.poolFundingOrigin || req.headers['sec-fetch-site'] !== 'same-origin') {
        throw new HttpError(403, 'wallet_origin', 'Submit the keeper envelope from the exchange.');
      }
      const { pool, index, ...envelope } = await readJson(req, 1024) ?? {};
      if (index !== 0 && index !== 1) throw new HttpError(400, 'invalid_keeper', 'Invalid keeper index.');
      try { return [200, { acknowledgment: await poolKeeperAck(pool, index, envelope) }]; }
      catch { throw new HttpError(422, 'keeper_ack', 'The keeper could not validate the encrypted position.'); }
    },
    'POST /api/pool/funding': async (req) => {
      if (!poolFunding) throw new HttpError(404, 'not_found', 'Test funding is unavailable on this host.');
      if (req.headers.origin !== config.poolFundingOrigin || req.headers['sec-fetch-site'] !== 'same-origin') {
        throw new HttpError(403, 'wallet_origin', 'Submit the funding request from the exchange.');
      }
      return [200, await poolFunding(await readJson(req))];
    },
    'POST /api/proving/local-pool': async (req) => {
      if (!poolProver || config.hosted) throw new HttpError(404, 'not_found', 'local proof helper is unavailable');
      const origin = req.headers.origin;
      if (!/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(origin ?? '')
        || origin.slice(7) !== req.headers.host || req.headers['sec-fetch-site'] !== 'same-origin') {
        throw new HttpError(403, 'local_origin', 'proof requests must come from the local exchange');
      }
      const { kind, fingerprint, witness } = await readJson(req, 21_000) ?? {};
      return [200, await poolProver({ kind, fingerprint, witness })];
    },
    'POST /api/faucet/claim': async (req) => {
      admit(req);
      if (!config.walletFaucet) throw new HttpError(503, 'faucet_disabled', 'wallet funding is unavailable');
      const origin = req.headers.origin;
      const localOrigin = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[1-9]\d{0,4})?$/.test(origin ?? '')
        && origin.slice('http://'.length) === req.headers.host;
      if (!origin || (config.walletOrigin ? origin !== config.walletOrigin : !localOrigin || config.hosted)) {
        throw new HttpError(403, 'wallet_origin', 'faucet requests must come from the exchange origin');
      }
      return [201, await coordinator.claimFaucet(await readJson(req), origin, req.socket.remoteAddress)];
    },
    'GET /api/market-data': async () => {
      if (!coordinator.marketData) throw new HttpError(503, 'market_data_unavailable', 'live BTC/USDT data is unavailable');
      return [200, await coordinator.marketData.get()];
    },
    // The invite gate runs before the body is read and before the coordinator
    // (proof check, quota, cooldown, provisioning) sees the request.
    'POST /api/sessions': async (req) => {
      admit(req);
      return [201, await coordinator.createSession(await readJson(req), req.socket.remoteAddress)];
    },
    'GET /api/session': async (req) => {
      const { record, token } = coordinator.authenticate(req.headers.authorization);
      return [200, await coordinator.sessionView(record, token)];
    },
    'POST /api/session/approve': async (req) => {
      const { record } = coordinator.authenticate(req.headers.authorization);
      return [200, await coordinator.approve(record, await readJson(req))];
    },
    'POST /api/session/mark': async (req) => {
      const { record } = coordinator.authenticate(req.headers.authorization);
      return [200, await coordinator.mark(record, await readJson(req))];
    },
    'POST /api/session/refresh': async (req) => {
      const { record } = coordinator.authenticate(req.headers.authorization);
      return [200, await coordinator.refresh(record, await readJson(req))];
    },
    'POST /api/session/keeper': async (req) => {
      const { record } = coordinator.authenticate(req.headers.authorization);
      return [200, await coordinator.keeper(record, await readJson(req))];
    },
    'GET /api/health': async () => [200, {
      ok: true, chain_id: 'testnet', sessions: coordinator.store.size, session_quota: config.sessionQuota,
      ...(config.walletFaucet && !config.hosted && { connected_wallet: true }),
      ...(poolProver && !config.hosted && { local_pool_prover: true }),
      ...(poolFunding && { pool_funding: true }),
    }],
  };

  async function serveStatic(req, res, pathname) {
    if (!config.serveDist) return false;
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return false;
    }
    // No traversal and no dot paths (/.env, /.git/...): never a file, never the SPA fallback.
    if (decoded.includes('\0') || decoded.split(/[\\/]/).some((segment) => segment.startsWith('.'))) return false;
    const target = resolve(join(distRoot, decoded));
    if (target !== distRoot && !target.startsWith(distRoot + sep)) return false;
    if (/^\/shielded\/(browser|judge)-pool\/(spend|close)\.pk$/.test(decoded)) {
      return sendFile(res, target, 'application/octet-stream', 'no-cache');
    }
    const type = STATIC_TYPES[extname(target).toLowerCase()];
    if (type && await sendFile(res, target, type, 'no-cache')) return true;
    // Single-page fallback for client routes without a file extension.
    if (extname(decoded) === '') {
      return sendFile(res, join(distRoot, 'index.html'), STATIC_TYPES['.html'], 'no-cache');
    }
    return false;
  }

  return async function handle(req, res) {
    if (config.hosted) res.xythumHeaders = HOSTED_HEADERS;
    const started = Date.now();
    let route = 'other';
    let status = 500;
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      if (config.hosted && /^\/positions\/?$/.test(pathname)) res.xythumHeaders = POSITION_EXPLORER_HEADERS;
      const key = req.method + ' ' + pathname;
      if (routes[key]) {
        route = key;
        const [code, body] = await routes[key](req);
        status = code;
        sendJson(res, code, body);
      } else if (req.method === 'GET' && (PROVING_FILES[pathname] || POOL_PROVING_FILES[pathname])) {
        route = 'GET ' + pathname;
        // Fixed file names only: the proving directory itself is never browsable.
        const directory = POOL_PROVING_FILES[pathname] ? config.poolProvingDir : config.provingDir;
        const file = PROVING_FILES[pathname] ?? POOL_PROVING_FILES[pathname];
        const served = directory && await sendFile(res, join(directory, file),
          'application/octet-stream', 'no-cache');
        status = served ? 200 : 404;
        if (!served) sendJson(res, 404, { error: 'not_found', message: 'proving key is unavailable' });
      } else if (pathname.startsWith('/api/')) {
        status = Object.keys(routes).some((name) => name.endsWith(' ' + pathname)) ? 405 : 404;
        sendJson(res, status, { error: status === 405 ? 'method_not_allowed' : 'not_found', message: 'no such endpoint' });
      } else if (req.method === 'GET' && await serveStatic(req, res, pathname)) {
        route = 'static';
        status = 200;
      } else {
        status = 404;
        sendJson(res, 404, { error: 'not_found', message: 'not found' });
      }
    } catch (error) {
      if (error instanceof HttpError) {
        status = error.status;
        if (!res.headersSent) sendJson(res, error.status, { error: error.code, message: error.message }, error.headers);
      } else {
        status = 500;
        log('error ' + route + ': ' + safeMessage(error));
        if (!res.headersSent) sendJson(res, 500, { error: 'internal', message: 'internal error' });
        else res.destroy();
      }
    } finally {
      log(route + ' ' + status + ' ' + (Date.now() - started) + 'ms');
    }
  };
}
