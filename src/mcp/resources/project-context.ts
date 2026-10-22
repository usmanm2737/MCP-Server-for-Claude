import { ResourceTemplate } from '@modelcontextprotocol/server';
import type { McpServer } from '@modelcontextprotocol/server';

import type { Container } from '../../container.js';

/**
 * Stable resource URI scheme for this server: `memory://projects/{projectName}/context`.
 * `projectName` is URI-component-encoded/decoded at the boundary so names with spaces or
 * punctuation round-trip correctly.
 */
export const PROJECT_CONTEXT_URI_TEMPLATE = 'memory://projects/{projectName}/context';

function firstValue(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

export function registerProjectContextResource(server: McpServer, container: Container): void {
  const template = new ResourceTemplate(PROJECT_CONTEXT_URI_TEMPLATE, {
    list: () => ({
      resources: container.contextService.listProjectNames(100).map((name) => ({
        uri: `memory://projects/${encodeURIComponent(name)}/context`,
        name,
        title: `${name} — project context`,
        description: `Saved state, recent activity, decisions, and open tasks for "${name}".`,
        mimeType: 'application/json',
      })),
    }),
  });

  server.registerResource(
    'project-context',
    template,
    {
      title: 'Project Context',
      description:
        'Saved state, recent activity, decisions, and open/blocked tasks for one project, addressed by name.',
      mimeType: 'application/json',
    },
    (uri, variables) => {
      const projectName = decodeURIComponent(firstValue(variables.projectName));
      // Lets NotFoundError (unknown project) propagate: the SDK turns a thrown
      // error from a resource handler into a JSON-RPC error response, which is
      // the correct signal here — unlike tools, resources have no `isError` result shape.
      const context = container.contextService.getProjectContext({ projectName });
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(context, null, 2),
          },
        ],
      };
    },
  );
}
