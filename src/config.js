import fs from 'node:fs';
import path from 'node:path';
import { ConfigError } from './errors.js';

export const ROOT_DIR = path.resolve(import.meta.dirname, '..');

const SNOWFLAKE = /^\d{17,20}$/;

/**
 * Reads the configuration from environment variables (or the .env file in the project folder).
 * Variables already set in the environment take precedence over the .env file.
 */
export function loadConfig(env = process.env) {
  const envFile = path.join(ROOT_DIR, '.env');
  if (env === process.env && fs.existsSync(envFile)) process.loadEnvFile(envFile);

  const missing = [];
  const required = (name) => {
    const value = env[name]?.trim();
    if (!value) missing.push(name);
    return value;
  };
  const optional = (name, fallback) => env[name]?.trim() || fallback;
  const integer = (name, fallback, min, max) => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new ConfigError(`${name} must be a whole number between ${min} and ${max} (got "${raw}").`);
    }
    return value;
  };

  const config = {
    discordToken: required('DISCORD_TOKEN'),
    guildId: required('DISCORD_GUILD_ID'),
    ownerIds: optional('OWNER_IDS', '').split(/[\s,;]+/).filter(Boolean),
    cloudflareToken: required('CLOUDFLARE_API_TOKEN'),
    cloudflareAccountId: optional('CLOUDFLARE_ACCOUNT_ID', null),
    workerName: optional('WORKER_NAME', 'email4u-relay').toLowerCase(),
    dataDir: path.resolve(ROOT_DIR, optional('DATA_DIR', 'data')),
    mailRetentionDays: integer('MAIL_RETENTION_DAYS', 30, 0, 3650),
    uploadLimitMb: integer('UPLOAD_LIMIT_MB', 0, 0, 500),
    logLevel: optional('LOG_LEVEL', 'info').toLowerCase(),
  };

  if (missing.length) {
    throw new ConfigError(`Missing settings: ${missing.join(', ')}. Add them to .env (template: .env.example).`);
  }
  if (!SNOWFLAKE.test(config.guildId)) throw new ConfigError('DISCORD_GUILD_ID must be a server ID (digits only).');
  const badOwner = config.ownerIds.find((id) => !SNOWFLAKE.test(id));
  if (badOwner) throw new ConfigError(`OWNER_IDS contains an invalid user ID: "${badOwner}".`);
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(config.workerName)) {
    throw new ConfigError('WORKER_NAME may only contain a-z, 0-9 and "-" (max. 63 characters).');
  }
  return config;
}
