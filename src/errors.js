/** Expected error whose message is shown to the Discord user as-is. */
export class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserError';
  }
}

/** Missing or invalid configuration (.env). */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}
