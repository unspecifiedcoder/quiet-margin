import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const operatorFile = '/run/quiet-margin/operators.env';
const asset = async (name) => JSON.parse(await readFile(`exchange/dist/shielded/judge-pool/${name}.json`, 'utf8'));
const [{ pool: live }, { pool: controlled }] = await Promise.all([asset('live-config'), asset('keeper-config')]);
const operator = 'scripts/shielded-pool-operator.mjs';
const tasks = [
  ['judge', 'exchange/server/judge-server.mjs'],
  ['oracle', operator, 'oracle', live, operatorFile, '--watch'],
  ['keeper-live-a', operator, 'keeper', live, operatorFile, 'A', '--watch'],
  ['keeper-live-b', operator, 'keeper', live, operatorFile, 'B', '--watch'],
  ['keeper-controlled-b', operator, 'keeper', controlled, operatorFile, 'B', '--watch'],
];

const env = { ...process.env };
delete env.QUIET_OPERATOR_FILE_B64;
delete env.QUIET_KEEPER_FILE_B64;
const workers = [];
let stopping = false;
let exitCode = 0;

function stop(code) {
  if (stopping) return;
  stopping = true;
  exitCode = code;
  for (const child of workers) child.kill('SIGTERM');
  setTimeout(() => {
    for (const child of workers) child.kill('SIGKILL');
  }, 15_000).unref();
}

process.on('SIGTERM', () => stop(0));
process.on('SIGINT', () => stop(0));
await Promise.all(tasks.map(([name, ...args]) => new Promise((resolve) => {
  const childEnv = { ...env };
  if (name !== 'judge') delete childEnv.QUIET_POOL_SPONSOR_KEY;
  const child = spawn(process.execPath, args, { env: childEnv, stdio: 'inherit' });
  workers.push(child);
  child.once('error', () => {
    console.error(`${name} failed to start`);
    stop(1);
  });
  child.once('close', () => {
    if (!stopping) console.error(`${name} exited unexpectedly`);
    stop(1);
    resolve();
  });
})));
process.exitCode = exitCode;
