import path from 'node:path';
import { Client, Events, GatewayIntentBits, OAuth2Scopes } from 'discord.js';
import { CloudflareClient, CloudflareError } from './cloudflare/client.js';
import { DomainDirectory } from './cloudflare/domains.js';
import { deployRelay, relaySecret, resolveAccountId } from './cloudflare/relay-deploy.js';
import { loadConfig } from './config.js';
import { Store } from './db.js';
import { createAudit } from './discord/audit.js';
import { commandDefinitions } from './discord/commands.js';
import { ForumManager, REQUIRED_GUILD_PERMISSIONS } from './discord/forums.js';
import { registerInteractions } from './discord/interactions.js';
import { ConfigError } from './errors.js';
import { createLogger } from './log.js';
import { MailDelivery } from './mail/deliver.js';
import { RelayClient } from './relay/client.js';
import { Access } from './services/access.js';
import { AddressService } from './services/addresses.js';
import { syncWithCloudflare } from './services/sync.js';

const MINUTE = 60_000;
const CLOUDFLARE_RETRY = 5 * MINUTE;

function applicationOwners(application) {
  const owner = application.owner;
  if (!owner) return [];
  if (owner.members) {
    // Team: team owner and admins
    const admins = [...owner.members.values()].filter((m) => m.role === 'admin').map((m) => m.id);
    return [owner.ownerId, ...admins];
  }
  return [owner.id];
}

function every(ms, name, log, fn) {
  const run = () => Promise.resolve().then(fn).catch((err) => log.warn(`${name} failed: ${err.message}`));
  const timer = setInterval(run, ms);
  timer.unref();
  return run;
}

async function main() {
  const config = loadConfig();
  const log = createLogger(config.logLevel);
  log.info('E-Mail4U is starting …');

  const store = new Store(path.join(config.dataDir, 'email4u.db'));
  const cf = new CloudflareClient({ token: config.cloudflareToken, log });
  const domains = new DomainDirectory({ cf, accountId: config.cloudflareAccountId, workerName: config.workerName, log });

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    allowedMentions: { parse: [] },
    // Large attachments need longer than the default 15 s on slow uplinks.
    rest: { timeout: 120_000, retries: 2 },
  });
  const access = new Access({ store, config });
  const audit = createAudit({ client, store, log });
  const forums = new ForumManager({ client, store, config, log });
  const addresses = new AddressService({ store, domains, forums, access, log, audit });
  const delivery = new MailDelivery({
    store, forums, access, domains, config, log, audit, isDiscordReady: () => client.isReady(),
  });
  const relay = new RelayClient({
    url: null, secret: relaySecret(store), log, onMail: (meta, raw) => delivery.handle(meta, raw),
  });
  const app = {
    config, log, store, cf, domains, client, access, audit, forums, addresses, delivery, relay,
    cloudflare: { ready: false, error: null },
  };

  registerInteractions(app);
  client.on(Events.ThreadDelete, (thread) => {
    if (store.forgetThread(thread.id)) log.info(`Thread ${thread.id} was deleted – it will be recreated with the next mail`);
  });
  client.on(Events.ChannelDelete, (channel) => {
    if (store.forgetForum(channel.id)) log.info(`Forum ${channel.id} was deleted – it will be recreated when needed`);
  });
  client.on(Events.Error, (err) => log.error('Discord:', err));

  const registerCommands = async (guild) => {
    await guild.commands.set(commandDefinitions());
    log.info(`Registered slash commands on "${guild.name}"`);
    if (!store.getSetting('category_id')) log.warn('No category set yet – run `/setup category:` in Discord.');
  };
  // If the bot is invited after it started, register the commands right away (no restart needed).
  client.on(Events.GuildCreate, (guild) => {
    if (guild.id !== config.guildId) return;
    log.info(`Bot was invited to "${guild.name}"`);
    registerCommands(guild).catch((err) => log.error('Slash commands not registered:', err));
  });

  const startJobs = () => {
    const sync = every(30 * MINUTE, 'Cloudflare sync', log, () => syncWithCloudflare(app));
    every(10 * MINUTE, 'Domain refresh', log, () => domains.refresh());
    const cleanup = every(6 * 60 * MINUTE, 'Cleanup', log, () => delivery.cleanup());
    setTimeout(sync, MINUTE).unref();
    setTimeout(cleanup, 5 * MINUTE).unref();
  };

  // Set up Cloudflare. If that fails (e.g. no workers.dev subdomain yet), don't crash but retry
  // later – the bot stays reachable in Discord and shows the reason in /setup.
  const connectCloudflare = async () => {
    try {
      domains.accountId = await resolveAccountId(cf, config.cloudflareAccountId);
      await domains.refresh();
      const routed = domains.list().filter((z) => z.routing?.enabled).length;
      log.info(`Cloudflare: ${domains.list().length} active domain(s), ${routed} with Email Routing`);
      relay.url = await deployRelay({ cf, store, accountId: domains.accountId, workerName: config.workerName, log });
      app.cloudflare = { ready: true, error: null };
      relay.start();
      startJobs();
    } catch (err) {
      const hint = err instanceof CloudflareError && [400, 401, 403].includes(err.status)
        ? ' → Check CLOUDFLARE_API_TOKEN and its permissions (list in .env.example).'
        : '';
      app.cloudflare = { ready: false, error: `${err.message}${hint}` };
      log.error(`Cloudflare not ready yet: ${err.message}${hint} Retrying in ${CLOUDFLARE_RETRY / MINUTE} minutes.`);
      setTimeout(connectCloudflare, CLOUDFLARE_RETRY);
    }
  };

  client.once(Events.ClientReady, async () => {
    log.info(`Discord: logged in as ${client.user.tag}`);
    try {
      const application = await client.application.fetch();
      access.setApplicationOwners(applicationOwners(application));
      log.info(`Owner: ${access.ownerIds().join(', ') || 'unknown – set OWNER_IDS in .env'}`);

      const invite = client.generateInvite({
        scopes: [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands], permissions: REQUIRED_GUILD_PERMISSIONS,
      });
      const guild = await client.guilds.fetch(config.guildId).catch(() => null);
      if (!guild) {
        log.warn(`The bot is not on your server yet – invite it with this link:\n\n    ${invite}\n`);
      } else {
        await registerCommands(guild);
        log.info(`Invite link (if needed): ${invite}`);
      }
    } catch (err) {
      log.error('Setup after login incomplete:', err);
    }

    let relayAlarm = false;
    every(MINUTE, 'Relay monitor', log, () => {
      const { connected, disconnectedSince, lastError } = relay.status;
      if (!connected && disconnectedSince && Date.now() - disconnectedSince > 10 * MINUTE && !relayAlarm) {
        relayAlarm = true;
        const reason = app.cloudflare.error ?? lastError;
        audit(`⚠️ No connection to the Cloudflare worker since <t:${Math.floor(disconnectedSince / 1000)}:R>`
          + `${reason ? ` (${reason})` : ''}. Mails are buffered there and delivered as soon as the connection is back.`);
      } else if (connected && relayAlarm) {
        relayAlarm = false;
        audit('✅ Connection to the Cloudflare worker restored.');
      }
    });

    await connectCloudflare();
  });

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal} received – shutting down`);
    relay.stop();
    await client.destroy().catch(() => {});
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => log.error('Unhandled error:', err));

  await client.login(config.discordToken);
}

main().catch((err) => {
  if (err instanceof ConfigError) console.error(`Configuration error: ${err.message}`);
  else if (err?.code === 'TokenInvalid') console.error('E-Mail4U could not start – DISCORD_TOKEN is invalid.');
  else console.error('E-Mail4U could not start:', err);
  process.exit(1);
});
