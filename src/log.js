const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level = 'info') {
  const min = LEVELS[level] ?? LEVELS.info;

  function write(lvl, args) {
    if (LEVELS[lvl] < min) return;
    // Local time (set TZ, e.g. TZ=Europe/Berlin), formatted as 2026-09-30 15:04:05
    const ts = new Date().toLocaleString('sv-SE');
    const out = LEVELS[lvl] >= LEVELS.warn ? console.error : console.log;
    out(`[${ts}] ${lvl.toUpperCase().padEnd(5)}`, ...args);
  }

  return {
    debug: (...args) => write('debug', args),
    info: (...args) => write('info', args),
    warn: (...args) => write('warn', args),
    error: (...args) => write('error', args),
  };
}

/** Logger without output, e.g. for tests. */
export const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
