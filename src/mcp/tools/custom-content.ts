import type { McpServer } from '@modelcontextprotocol/server';

import type { Container } from '../../container.js';
import { savePromptInputSchema, saveResourceInputSchema } from '../../domain/schemas.js';
import { runTool, toolOk } from '../tool-helpers.js';

/**
 * Registers `save_prompt` and `save_resource`: the write path for
 * user-defined prompts/resources (see `CustomContentService` for the
 * persistence rules). Saved content becomes a real, listable MCP
 * prompt/resource the next time a client connects — see
 * `src/mcp/prompts/custom-prompts.ts` and `src/mcp/resources/custom-resources.ts`
 * for where it actually gets registered.
 */
export function registerCustomContentTools(server: McpServer, container: Container): void {
  server.registerTool(
    'save_prompt',
    {
      title: 'Save Prompt',
      description:
        'Save a reusable prompt template so it becomes a real, selectable MCP prompt on this server. ' +
        'Saving again under the same name updates it in place. The new/updated prompt is available ' +
        'immediately in this session and to any client that connects (or reconnects) afterward.',
      inputSchema: savePromptInputSchema,
    },
    (input) =>
      runTool('save_prompt', () => {
        const prompt = container.customContentService.savePrompt(input);
        return toolOk({
          name: prompt.name,
          title: prompt.title,
          createdAt: prompt.createdAt,
          updatedAt: prompt.updatedAt,
        });
      }),
  );

  server.registerTool(
    'save_resource',
    {
      title: 'Save Resource',
      description:
        'Save a chunk of content so it becomes a real, readable MCP resource at ' +
        'memory://custom/{name} on this server. Saving again under the same name updates it in ' +
        'place. The new/updated resource is available immediately in this session and to any ' +
        'client that connects (or reconnects) afterward.',
      inputSchema: saveResourceInputSchema,
    },
    (input) =>
      runTool('save_resource', () => {
        const resource = container.customContentService.saveResource(input);
        return toolOk({
          name: resource.name,
          uri: `memory://custom/${resource.name}`,
          title: resource.title,
          mimeType: resource.mimeType,
          createdAt: resource.createdAt,
          updatedAt: resource.updatedAt,
        });
      }),
  );
}
