#!/usr/bin/env node
/**
 * Separate, optional entrypoint for the Express ingestion API. Deliberately
 * never imported by `src/index.ts` (the stdio MCP entrypoint) — the two
 * processes share only `src/container.ts` and the database, so a crash or
 * restart of one never affects the other, and nothing here can write to
 * stdout and corrupt the MCP JSON-RPC stream.
 */
import { loadConfig } from '../config/env.js';
import { buildContainer } from '../container.js';
import { createHttpApp } from './app.js';
import { logger } from '../utils/logging.js';

async function main(): Promise<void> {
  const config = loadConfig();

  if (!config.http.enabled) {
    logger.error(
      'HTTP API is disabled (CLAUDE_MEMORY_HTTP_ENABLED is not "true"). Refusing to bind a port. ' +
        'Set CLAUDE_MEMORY_HTTP_ENABLED=true and CLAUDE_MEMORY_HTTP_TOKEN in your .env to enable it.',
    );
    process.exitCode = 1;
    return;
  }

  const container = await buildContainer(config);
  const app = createHttpApp(container, config);

  const server = app.listen(config.http.port, config.http.host, () => {
    logger.info('claude-activity-memory HTTP ingestion API listening', {
      host: config.http.host,
      port: config.http.port,
      corsOrigins: config.http.corsOrigins,
    });
  });

  // Bounded request handling: a slow/stalled client should not hold a connection open indefinitely.
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;

  const shutdown = (): void => {
    server.close(() => {
      container.db
        .close()
        .catch((err: unknown) =>
          logger.error('error closing database pool', { error: String(err) }),
        )
        .finally(() => process.exit(0));
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  logger.error('fatal startup error', { error: String(err) });
  process.exitCode = 1;
});
