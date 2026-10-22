import type { McpServer } from '@modelcontextprotocol/server';

import type { Container } from '../../container.js';
import {
  getMemoryStatsInputSchema,
  getProjectContextInputSchema,
  updateProjectStateInputSchema,
} from '../../domain/schemas.js';
import { runTool, toolOk } from '../tool-helpers.js';

/** Registers `get_project_context`, `update_project_state`, and `get_memory_stats`. */
export function registerProjectTools(server: McpServer, container: Container): void {
  server.registerTool(
    'get_project_context',
    {
      title: 'Get Project Context',
      description:
        'Retrieve a project’s saved state for resuming work: description, current state, next steps, ' +
        'recent activities (summaries only, not full content), open/blocked tasks, and active decisions. ' +
        'Fails with a clear error if the project does not exist — it does not create one.',
      inputSchema: getProjectContextInputSchema,
    },
    (input) =>
      runTool('get_project_context', () => {
        const context = container.contextService.getProjectContext(input);
        return toolOk({ ...context });
      }),
  );

  server.registerTool(
    'update_project_state',
    {
      title: 'Update Project State',
      description:
        'Persist a project’s current state and next steps (creates the project if it does not exist yet). ' +
        'Leaves a state-update activity behind so the change is visible in get_recent_activity/search_activity. ' +
        'Unrelated project fields (description, id, created_at) are preserved.',
      inputSchema: updateProjectStateInputSchema,
    },
    (input) =>
      runTool('update_project_state', () => {
        const project = container.projectService.updateProjectState(input);
        return toolOk({ ...project });
      }),
  );

  server.registerTool(
    'get_memory_stats',
    {
      title: 'Get Memory Stats',
      description:
        'Report database health: schema version, row counts per table, oldest/newest activity timestamps, ' +
        'and whether the full-text search index passes its integrity check. Never returns secrets or credentials.',
      inputSchema: getMemoryStatsInputSchema,
    },
    () =>
      runTool('get_memory_stats', () => {
        const stats = container.projectService.getMemoryStats();
        return toolOk({ ...stats });
      }),
  );
}
