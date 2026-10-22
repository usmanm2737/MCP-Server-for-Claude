#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import { loadConfig } from './config/env.js';
import { buildContainer } from './container.js';
import { createMcpServer } from './mcp/server.js';
import { logger } from './utils/logging.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const container = await buildContainer(config);

  // Async cleanup must happen in a signal handler, not an `'exit'` listener —
  // Node does not wait for async work started from `'exit'` before terminating.
  const shutdown = (): void => {
    container.db
      .close()
      .catch((err: unknown) => logger.error('error closing database pool', { error: String(err) }))
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const server = createMcpServer(container);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info('claude-activity-memory MCP server connected over stdio', {
    database: config.databaseDisplayName,
  });
}

main().catch((err: unknown) => {
  logger.error('fatal startup error', { error: String(err) });
  process.exitCode = 1;
});
