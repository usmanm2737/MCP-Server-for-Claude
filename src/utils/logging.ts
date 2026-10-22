/**
 * Minimal structured logger.
 *
 * Writes exclusively to stderr. The stdio MCP transport uses stdout as the
 * JSON-RPC wire; anything else written there corrupts the protocol stream.
 * `console.log`/`console.info` must never be used in this codebase — use
 * this logger (or `console.error`, which this wraps) instead.
 *
 * Keep log lines to event names and ids/counts, not full activity or
 * conversation bodies — those belong in the database, not routine logs.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

interface LogFields {
  [key: string]: unknown;
}

function write(level: Level, message: string, fields?: LogFields): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...fields,
  };
  process.stderr.write(JSON.stringify(entry) + '\n');
}

export const logger = {
  debug: (message: string, fields?: LogFields) => {
    if (process.env.CLAUDE_MEMORY_LOG_LEVEL === 'debug') write('debug', message, fields);
  },
  info: (message: string, fields?: LogFields) => write('info', message, fields),
  warn: (message: string, fields?: LogFields) => write('warn', message, fields),
  error: (message: string, fields?: LogFields) => write('error', message, fields),
};
