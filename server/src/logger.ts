/**
 * Structured logger with levels and timestamps.
 * Outputs to stdout/stderr with ISO timestamps.
 *
 * Usage:
 *   import { log } from './logger.js';
 *   log.info('server', 'Started on port 3001');
 *   log.warn('lrclib', 'Server error 503 — retrying');
 *   log.error('db', 'Migration failed', err);
 */

type Level = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LOG_LEVEL_ENV = (process.env.LOG_LEVEL ?? 'INFO').toUpperCase() as Level;
const LEVEL_ORDER: Record<Level, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const minLevel = LEVEL_ORDER[LOG_LEVEL_ENV] ?? LEVEL_ORDER.INFO;

function ts(): string {
  return new Date().toISOString();
}

function shouldLog(level: Level): boolean {
  return LEVEL_ORDER[level] >= minLevel;
}

function format(level: Level, tag: string, msg: string): string {
  return `${ts()} [${level.padEnd(5)}] [${tag}] ${msg}`;
}

export const log = {
  debug(tag: string, msg: string, ...args: unknown[]): void {
    if (shouldLog('DEBUG')) {
      console.debug(format('DEBUG', tag, msg), ...args);
    }
  },

  info(tag: string, msg: string, ...args: unknown[]): void {
    if (shouldLog('INFO')) {
      console.log(format('INFO', tag, msg), ...args);
    }
  },

  warn(tag: string, msg: string, ...args: unknown[]): void {
    if (shouldLog('WARN')) {
      console.warn(format('WARN', tag, msg), ...args);
    }
  },

  error(tag: string, msg: string, ...args: unknown[]): void {
    if (shouldLog('ERROR')) {
      console.error(format('ERROR', tag, msg), ...args);
    }
  },
};
