// Integration test: the real relay worker (worker/relay.js) running locally in wrangler/workerd,
// plus the bot's real RelayClient.  Run with: npm run test:relay
// Needs internet access on the first run (npx downloads wrangler).

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { silentLogger } from '../src/log.js';
import { RelayClient } from '../src/relay/client.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'integration-secret';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'email4u-relay-'));
fs.writeFileSync(path.join(dir, 'wrangler.toml'), `
name = "email4u-relay-test"
main = "${path.join(ROOT, 'worker', 'relay.js').replaceAll('\\', '/')}"
compatibility_date = "2025-09-01"

[[durable_objects.bindings]]
name = "RELAY"
class_name = "Relay"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["Relay"]

[vars]
RELAY_SECRET = "${SECRET}"
`);

function startWrangler() {
  const child = spawn('npx', ['--yes', 'wrangler@4', 'dev', '--config', path.join(dir, 'wrangler.toml'),
    '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', path.join(dir, 'state'), '--show-interactive-dev-session=false'], {
    cwd: dir, shell: process.platform === 'win32', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' },
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`wrangler did not start:\n${output}`)), 180_000);
    const check = setInterval(async () => {
      try {
        const res = await fetch(`${BASE}/ws`);
        if (res.status === 401) {
          clearInterval(check);
          clearTimeout(timer);
          resolve();
        }
      } catch {
        // not ready yet
      }
    }, 500);
    child.on('exit', (code) => {
      clearInterval(check);
      clearTimeout(timer);
      reject(new Error(`wrangler exited (${code}):\n${output}`));
    });
  });
  return { child, ready, output: () => output };
}

function stop(child) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  else child.kill('SIGTERM');
}

function rawMail(id, body) {
  return [
    'From: Test <sender@example.org>', 'To: box@example.com', `Subject: Test ${id}`,
    `Message-ID: <${id}@example.org>`, 'Date: Tue, 29 Sep 2026 10:00:00 +0000', 'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8', '', body, '',
  ].join('\r\n');
}

async function sendMail(id, body, to = 'box@example.com') {
  const url = `${BASE}/cdn-cgi/local/email?from=${encodeURIComponent('sender@example.org')}&to=${encodeURIComponent(to)}`;
  const res = await fetch(url, { method: 'POST', body: rawMail(id, body), headers: { 'Content-Type': 'message/rfc822' } });
  assert.ok(res.ok, `mail ${id} not accepted: ${res.status} ${await res.text()}`);
}

const waitFor = (predicate, timeout = 15_000) => new Promise((resolve, reject) => {
  const started = Date.now();
  const tick = () => {
    if (predicate()) return resolve();
    if (Date.now() - started > timeout) return reject(new Error('Timed out while waiting'));
    return setTimeout(tick, 50);
  };
  tick();
});

const wrangler = startWrangler();
let client;
let second;
try {
  await wrangler.ready;
  console.log('wrangler dev is running');

  // 1) Access control
  assert.equal((await fetch(`${BASE}/ws`)).status, 401);
  assert.equal((await fetch(`${BASE}/ws`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  const info = await fetch(`${BASE}/ws`, { headers: { Authorization: `Bearer ${SECRET}` } });
  assert.deepEqual(await info.json(), { ok: true, protocol: 1 });
  assert.equal((await fetch(`${BASE}/anything`)).status, 404);
  console.log('✓ access control');

  // 2) A mail arrives while the bot is offline → it is buffered
  await sendMail('offline-1', 'This mail arrived while the bot was offline.');

  const received = [];
  let failNext = false;
  client = new RelayClient({
    url: `ws://127.0.0.1:${PORT}/ws`, secret: SECRET, log: silentLogger, retryBaseMs: 200, reconnectBaseMs: 200,
    onMail: async (meta, raw) => {
      if (failNext) {
        failNext = false;
        throw new Error('simulated failure');
      }
      received.push({ meta, raw });
    },
  });
  client.start();
  await waitFor(() => received.length === 1);
  assert.equal(received[0].meta.to, 'box@example.com');
  assert.equal(received[0].meta.from, 'sender@example.org');
  assert.ok(received[0].raw.toString().includes('while the bot was offline'));
  console.log('✓ buffered mail fetched');

  // 3) Large mail (several 512 KB chunks) while the bot is connected
  const bigBody = Array.from({ length: 30_000 }, (_, i) => `Line ${i} ${'x'.repeat(40)}`).join('\r\n');
  await sendMail('big-1', bigBody);
  await waitFor(() => received.length === 2);
  assert.ok(received[1].meta.chunks >= 3, `only ${received[1].meta.chunks} chunks`);
  assert.equal(received[1].raw.length, received[1].meta.size);
  assert.ok(received[1].raw.toString().includes('Line 29999'));
  console.log(`✓ large mail (${(received[1].meta.size / 1024 / 1024).toFixed(1)} MB, ${received[1].meta.chunks} chunks)`);

  // 4) Processing fails → the same mail is delivered again
  failNext = true;
  await sendMail('retry-1', 'Only on the second attempt.');
  await waitFor(() => received.length === 3);
  assert.ok(received[2].raw.toString().includes('second attempt'));
  await waitFor(() => client.status.pending === 0);
  console.log('✓ retried after a failure');

  // 5) A second instance takes over the connection, the first one gets code 4000
  second = new RelayClient({ url: `ws://127.0.0.1:${PORT}/ws`, secret: SECRET, log: silentLogger, onMail: async () => {} });
  second.start();
  await waitFor(() => second.status.connected);
  await waitFor(() => !client.status.connected);
  console.log('✓ only one connection at a time');

  console.log('\nAll relay integration tests passed.');
} catch (err) {
  console.error('FAILED:', err);
  console.error(wrangler.output().slice(-4000));
  process.exitCode = 1;
} finally {
  client?.stop();
  second?.stop();
  stop(wrangler.child);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}
