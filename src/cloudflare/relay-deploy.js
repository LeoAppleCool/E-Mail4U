import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT_DIR } from '../config.js';
import { CloudflareError } from './client.js';

const WORKER_FILE = path.join(ROOT_DIR, 'worker', 'relay.js');
const MODULE_NAME = 'relay.js';
const MIGRATION_TAG = 'v1';
const COMPATIBILITY_DATE = '2025-09-01';
const SUBDOMAIN_NOT_FOUND = 10007;

/** Finds the account ID (from .env, or via the token if it can only see one account). */
export async function resolveAccountId(cf, configured) {
  if (configured) return configured;
  const accounts = await cf.paginate('/accounts');
  if (accounts.length === 1) return accounts[0].id;
  if (!accounts.length) {
    throw new Error('The Cloudflare token cannot access any account. Check the token permissions (see .env.example).');
  }
  const list = accounts.map((a) => `${a.name} (${a.id})`).join(', ');
  throw new Error(`The token can access several accounts – set CLOUDFLARE_ACCOUNT_ID in .env. Found: ${list}`);
}

/** Secret the bot uses to authenticate against the worker (generated once, stored in the database). */
export function relaySecret(store) {
  let secret = store.getSetting('relay_secret');
  if (!secret) {
    secret = randomBytes(32).toString('hex');
    store.setSetting('relay_secret', secret);
  }
  return secret;
}

async function accountSubdomain(cf, accountId) {
  try {
    const result = await cf.get(`/accounts/${accountId}/workers/subdomain`);
    if (result?.subdomain) return result.subdomain;
  } catch (err) {
    if (!(err instanceof CloudflareError && (err.status === 404 || err.hasCode(SUBDOMAIN_NOT_FOUND)))) throw err;
  }
  throw new Error('Your Cloudflare account has no workers.dev subdomain yet. Open '
    + 'https://dash.cloudflare.com/?to=/:account/workers/workers-and-pages once – Cloudflare creates it automatically.');
}

async function upload(cf, accountId, workerName, source, metadata) {
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append(MODULE_NAME, new Blob([source], { type: 'application/javascript+module' }), MODULE_NAME);
  return cf.request('PUT', `/accounts/${accountId}/workers/scripts/${workerName}`, { form });
}

/**
 * Uploads the relay worker (only if its code or secret changed), enables its workers.dev
 * route and returns the WebSocket URL.
 */
export async function deployRelay({ cf, store, accountId, workerName, log }) {
  const subdomain = await accountSubdomain(cf, accountId);
  const source = await fs.readFile(WORKER_FILE, 'utf8');
  const secret = relaySecret(store);
  const hash = createHash('sha256').update(`${source}\n${secret}\n${workerName}\n${COMPATIBILITY_DATE}`).digest('hex');

  const scripts = await cf.get(`/accounts/${accountId}/workers/scripts`);
  const existing = scripts?.find((s) => s.id === workerName) ?? null;

  if (!existing || store.getSetting('relay_hash') !== hash) {
    const metadata = {
      main_module: MODULE_NAME,
      compatibility_date: COMPATIBILITY_DATE,
      bindings: [
        { type: 'durable_object_namespace', name: 'RELAY', class_name: 'Relay' },
        { type: 'secret_text', name: 'RELAY_SECRET', text: secret },
      ],
    };
    const migrations = {
      ...(existing?.migration_tag ? { old_tag: existing.migration_tag } : {}),
      new_tag: MIGRATION_TAG,
      new_sqlite_classes: ['Relay'],
    };
    const needsMigration = existing?.migration_tag !== MIGRATION_TAG;
    try {
      await upload(cf, accountId, workerName, source, needsMigration ? { ...metadata, migrations } : metadata);
    } catch (err) {
      // If the reported migration state is wrong, try once more the other way round.
      if (!(err instanceof CloudflareError) || !/migrat|durable|class/i.test(err.message)) throw err;
      log.warn(`Worker upload ${needsMigration ? 'with' : 'without'} migration rejected, retrying the other way: ${err.message}`);
      await upload(cf, accountId, workerName, source, needsMigration ? metadata : { ...metadata, migrations });
    }
    store.setSetting('relay_hash', hash);
    log.info(`Relay worker "${workerName}" ${existing ? 'updated' : 'created'}`);
  }

  await cf.post(`/accounts/${accountId}/workers/scripts/${workerName}/subdomain`, { enabled: true, previews_enabled: false });
  return `wss://${workerName}.${subdomain}.workers.dev/ws`;
}
