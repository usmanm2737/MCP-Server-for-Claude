import type { McpServer } from '@modelcontextprotocol/server';

import type { Container } from '../../container.js';
import { logger } from '../../utils/logging.js';

/** Stable URI scheme for a saved custom resource: `memory://custom/{name}`. */
export function customResourceUri(name: string): string {
  return `memory://custom/${name}`;
}

/**
 * Registers every resource saved via the `save_resource` tool (see
 * `CustomContentService`) as a real, readable MCP resource, in addition to
 * the built-in `project-context` template. Runs once per `createMcpServer()`
 * call — i.e. once per session — so a resource saved in one session is
 * picked up the next time any client connects.
 *
 * Each registration is isolated in its own try/catch — see the matching note
 * in `src/mcp/prompts/custom-prompts.ts` for why.
 */
export function registerSavedCustomResources(server: McpServer, container: Container): void {
  for (const resource of container.customContentService.listResources()) {
    try {
      server.registerResource(
        resource.name,
        customResourceUri(resource.name),
        {
          title: resource.title ?? resource.name,
          description: resource.description ?? `Saved resource: ${resource.name}`,
          mimeType: resource.mimeType,
        },
        (uri) => ({
          contents: [{ uri: uri.href, mimeType: resource.mimeType, text: resource.content }],
        }),
      );
    } catch (err) {
      logger.error('failed to register a saved custom resource — skipping it', {
        name: resource.name,
        error: String(err),
      });
    }
  }
}
