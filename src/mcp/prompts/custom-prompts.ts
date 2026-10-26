import type { McpServer } from '@modelcontextprotocol/server';

import type { Container } from '../../container.js';
import { logger } from '../../utils/logging.js';

/**
 * Registers every prompt saved via the `save_prompt` tool (see
 * `CustomContentService`) as a real MCP prompt, in addition to the built-in
 * `resume_project` one. Runs once per `createMcpServer()` call — i.e. once
 * per session — so a prompt saved in one session is picked up the next time
 * any client connects. v1 prompts are flat text (no `{{arg}}` placeholders).
 *
 * Each registration is isolated in its own try/catch: one malformed saved
 * row must not stop the rest from registering, and — since this all runs
 * inside `createMcpServer()`, before the built-in tools are registered too —
 * must never crash server startup for every session until someone fixes the
 * database by hand.
 */
export function registerSavedCustomPrompts(server: McpServer, container: Container): void {
  for (const prompt of container.customContentService.listPrompts()) {
    try {
      server.registerPrompt(
        prompt.name,
        {
          title: prompt.title ?? prompt.name,
          description: prompt.description ?? `Saved prompt: ${prompt.name}`,
        },
        () => ({
          messages: [
            {
              role: 'user' as const,
              content: { type: 'text' as const, text: prompt.template },
            },
          ],
        }),
      );
    } catch (err) {
      logger.error('failed to register a saved custom prompt — skipping it', {
        name: prompt.name,
        error: String(err),
      });
    }
  }
}
