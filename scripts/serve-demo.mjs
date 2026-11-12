// Serves the static evidence replay in demo/ on the loopback interface.
// Only the files listed below are served. No other path in the repository,
// including .env and .testnet/, is reachable through this server.
//
//   node scripts/serve-demo.mjs [port]      (default 8787)

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const HOST = '127.0.0.1';
const port = Number(process.argv[2] ?? 8787);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error('Usage: node scripts/serve-demo.mjs [port 1024-65535]');
  process.exit(2);
}

const FILES = {
  '/index.html': 'text/html; charset=utf-8',
  '/styles.css': 'text/css; charset=utf-8',
  '/app.js': 'text/javascript; charset=utf-8',
  '/receipts.json': 'application/json; charset=utf-8',
};
// Read once at startup so request paths never reach the filesystem.
const bodies = Object.fromEntries(Object.keys(FILES).map((path) =>
  [path, readFileSync(new URL('../demo' + path, import.meta.url))]));

const allowedHosts = new Set([`${HOST}:${port}`, `localhost:${port}`]);
const headers = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; "
    + "img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

// new URL() rather than URL.parse(), which only exists from Node 22.1.
function pathOf(url) {
  try {
    return new URL(url, 'http://local').pathname;
  } catch {
    return null;
  }
}

const server = createServer((request, response) => {
  const path = pathOf(request.url);
  const file = path === '/' ? '/index.html' : path;
  // Reject unexpected Host headers so another site cannot rebind to this port.
  if (!allowedHosts.has(request.headers.host)) {
    response.writeHead(421, headers).end('Misdirected request\n');
  } else if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { ...headers, Allow: 'GET, HEAD' }).end();
  } else if (!Object.hasOwn(FILES, file)) {
    response.writeHead(404, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found\n');
  } else {
    response.writeHead(200, { ...headers, 'Content-Type': FILES[file], 'Content-Length': bodies[file].length });
    response.end(request.method === 'HEAD' ? undefined : bodies[file]);
  }
});

server.listen(port, HOST, () => {
  console.log(`Evidence replay at http://${HOST}:${port}/ (loopback only, Ctrl+C to stop)`);
});
