#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import { loadConfig } from './config/env.js';
import { buildContainer } from './container.js';
import { createMcpServer } from './mcp/server.js';
import { logger } from './utils/logging.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const container = buildContainer(config);

  process.on('exit', () => {
    try {
      container.db.close();
    } catch {
      // already closed
    }
  });
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));

  const server = createMcpServer(container);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info('claude-activity-memory MCP server connected over stdio', { dbPath: config.dbPath });
}

main().catch((err: unknown) => {
  logger.error('fatal startup error', { error: String(err) });
  process.exitCode = 1;
});
