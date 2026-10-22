#!/usr/bin/env node
/**
 * Remote MCP entrypoint: serves the *same* 8 tools/resource/prompt as the
 * stdio server (`src/index.ts`), but over the MCP "Streamable HTTP"
 * transport, so a remote client — e.g. claude.ai's web app, via a tunnel
 * like ngrok during testing, or a real deployment (Render) in production —
 * can connect to it.
 *
 * Deliberately a separate process/entrypoint from both `src/index.ts`
 * (stdio) and `src/http/index.ts` (the REST ingestion API): starting this
 * never affects, and is never affected by, either of those. Disabled
 * unless explicitly enabled, and refuses to start without an auth token,
 * exactly like the REST API. See `app.ts` for the actual Express app and
 * session handling.
 */
import { loadConfig } from '../config/env.js';
import { buildContainer } from '../container.js';
import { logger } from '../utils/logging.js';
import { createRemoteMcpApp } from './app.js';

async function main(): Promise<void> {
  const config = loadConfig();

  if (!config.remoteMcp.enabled) {
    logger.error(
      'Remote MCP HTTP server is disabled (CLAUDE_MEMORY_REMOTE_MCP_ENABLED is not "true"). ' +
        'Refusing to bind a port. Set CLAUDE_MEMORY_REMOTE_MCP_ENABLED=true and ' +
        'CLAUDE_MEMORY_REMOTE_MCP_TOKEN in your .env to enable it.',
    );
    process.exitCode = 1;
    return;
  }

  const container = await buildContainer(config);
  const app = createRemoteMcpApp(container, config);

  const server = app.listen(config.remoteMcp.port, config.remoteMcp.host, () => {
    logger.info('claude-activity-memory remote MCP server listening', {
      host: config.remoteMcp.host,
      port: config.remoteMcp.port,
      allowedHosts: config.remoteMcp.allowedHosts,
    });
  });

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
