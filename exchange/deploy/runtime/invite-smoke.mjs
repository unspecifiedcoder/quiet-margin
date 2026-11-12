// Offline behavioral check of the hosted invite gate, against the REAL
// exchange/server/app.mjs createApp and config.mjs loadConfig of a given tree,
// with a stub coordinator. No RPC, no credentials, no session data.
//
//   node exchange/deploy/runtime/invite-smoke.mjs [<app root>]
//
// Used by stage.mjs (on the scratch context) and by launch.mjs --self-check
// (inside the image). It passes only if hosted config refuses to load without
// a valid invite, and POST /api/sessions answers 401 invite_required for a
// missing, malformed or wrong invite WITHOUT reaching the coordinator, while
// the correct invite does reach it.
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export class InviteSmokeError extends Error {}

const fail = (message) => {
  throw new InviteSmokeError('invite smoke: ' + message);
};

export async function inviteSmoke(appRoot = fileURLToPath(new URL('../../../', import.meta.url))) {
  const server = (name) => pathToFileURL(join(appRoot, 'exchange', 'server', name)).href;
  const { createApp, INVITE_HEADER } = await import(server('app.mjs'));
  const { loadConfig } = await import(server('config.mjs'));
  if (typeof createApp !== 'function' || typeof loadConfig !== 'function') fail('server has no createApp/loadConfig');
  const header = INVITE_HEADER ?? 'x-xythum-invite';

  // Fixed fake absolute paths: loadConfig only checks their shape.
  const base = {
    XYTHUM_ALLOW_HOSTED: '1', XYTHUM_SERVER_HOST: '0.0.0.0', XYTHUM_SERVE_DIST: '0', XYTHUM_SESSION_QUOTA: '1',
    XYTHUM_SESSION_DIR: '/smoke/sessions', XYTHUM_PROVING_DIR: '/smoke/proving',
    MARKET_WASM: '/smoke/market.wasm', PROVER_BIN: '/smoke/prover',
  };
  for (const invite of [undefined, '', 'A'.repeat(64), 'a'.repeat(63)]) {
    let loaded = true;
    try {
      loadConfig({ ...base, XYTHUM_HOSTED_INVITE: invite });
    } catch {
      loaded = false;
    }
    if (loaded) fail('hosted config loaded with ' + (invite === undefined ? 'no' : 'an invalid') + ' invite');
  }
  const invite = randomBytes(32).toString('hex');
  const config = loadConfig({ ...base, XYTHUM_HOSTED_INVITE: invite });
  if (config.hosted !== true) fail('XYTHUM_ALLOW_HOSTED=1 did not select hosted mode');

  const calls = [];
  const coordinator = {
    store: { size: 0 },
    createSession: async (body) => {
      calls.push(body);
      return { session_id: 'smoke' };
    },
    authenticate: () => fail('authenticate reached'),
  };
  const http = createServer(createApp({ coordinator, config }));
  await new Promise((done, error) => http.once('error', error).listen(0, '127.0.0.1', done));
  try {
    const url = 'http://127.0.0.1:' + http.address().port + '/api/sessions';
    const post = (headers) => fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{"smoke":true}',
    });
    const refused = [
      ['missing', {}], ['empty', { [header]: '' }], ['uppercase', { [header]: invite.toUpperCase() }],
      ['short', { [header]: invite.slice(1) }], ['wrong', { [header]: randomBytes(32).toString('hex') }],
      ['bearer', { authorization: 'Bearer ' + invite }],
    ];
    for (const [what, headers] of refused) {
      const response = await post(headers);
      const body = await response.json().catch(() => ({}));
      if (response.status !== 401 || body.error !== 'invite_required') {
        fail(what + ' invite got HTTP ' + response.status + ' ' + String(body.error));
      }
      if (calls.length !== 0) fail(what + ' invite reached the coordinator');
    }
    const admitted = await post({ [header]: invite });
    if (admitted.status !== 201 || calls.length !== 1 || calls[0].smoke !== true) {
      fail('the correct invite did not reach the coordinator (HTTP ' + admitted.status + ')');
    }
  } finally {
    http.closeAllConnections();
    await new Promise((done) => http.close(done));
  }
  return { refused: 6, admitted: 1 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  inviteSmoke(process.argv[2] ? resolve(process.argv[2]) : undefined).then((result) => {
    console.log('invite smoke ok: ' + result.refused + ' refused before the coordinator, ' + result.admitted + ' admitted');
  }, (error) => {
    console.error(String(error?.message ?? error).slice(0, 300));
    process.exit(1);
  });
}
