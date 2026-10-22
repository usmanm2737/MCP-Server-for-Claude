import type { McpServer } from '@modelcontextprotocol/server';

import type { Container } from '../../container.js';
import {
  deleteActivityInputSchema,
  getRecentActivityInputSchema,
  saveActivityInputSchema,
  searchActivityInputSchema,
} from '../../domain/schemas.js';
import { runTool, toolOk } from '../tool-helpers.js';

/**
 * Registers the activity-log tools: `save_activity`, `search_activity`,
 * `get_recent_activity`, `delete_activity`.
 *
 * `save_activity` is the single write path for the activity log. Two
 * `activityType` values additionally fan out into other tables (documented
 * here and in CLAUDE.md so a connected client actually uses them):
 *   - `"decision"` also creates a row in the decisions table.
 *   - `"task"` or `"blocker"` also creates a row in the tasks table
 *     (`"blocker"` is created with status `blocked`).
 * There is no separate create_decision/create_task tool.
 */
export function registerActivityTools(server: McpServer, container: Container): void {
  server.registerTool(
    'save_activity',
    {
      title: 'Save Activity',
      description:
        'Save a milestone, technical decision, blocker, or next step to persistent project memory. ' +
        'Creates the project if it does not already exist. Use activityType "decision" to also record ' +
        'a Decision, and "task" or "blocker" to also record a Task (blocked status for "blocker"). ' +
        'Calls with identical projectName/activityType/title/summary/content are treated as the same ' +
        'activity and will not create a duplicate row.',
      inputSchema: saveActivityInputSchema,
    },
    (input) =>
      runTool('save_activity', async () => {
        const { activity, duplicate } = await container.activityService.saveActivity(input);
        return toolOk({
          id: activity.id,
          projectId: activity.projectId,
          createdAt: activity.createdAt,
          duplicate,
        });
      }),
  );

  server.registerTool(
    'search_activity',
    {
      title: 'Search Activity',
      description:
        'Full-text search over saved activities (title, summary, content). Optionally filter by project, ' +
        'activityType, and/or a createdAt date range. Returns a bounded list of snippets with ids — an ' +
        'unknown project or a query with no matches returns an empty list with an explanatory note, not an error.',
      inputSchema: searchActivityInputSchema,
    },
    (input) =>
      runTool('search_activity', async () => {
        const { hits, note } = await container.searchService.search(input);
        return toolOk({ results: hits, count: hits.length, ...(note ? { note } : {}) });
      }),
  );

  server.registerTool(
    'get_recent_activity',
    {
      title: 'Get Recent Activity',
      description:
        'List the most recently saved activities, newest first. Optionally filter by project and/or activityType.',
      inputSchema: getRecentActivityInputSchema,
    },
    (input) =>
      runTool('get_recent_activity', async () => {
        const { activities, note } = await container.activityService.getRecentActivity(input);
        return toolOk({ activities, count: activities.length, ...(note ? { note } : {}) });
      }),
  );

  server.registerTool(
    'delete_activity',
    {
      title: 'Delete Activity',
      description:
        'Permanently delete one activity by id. Requires confirm: true. Only the named activity is removed; ' +
        'any decisions/tasks that reference it are kept but detached, not cascade-deleted.',
      inputSchema: deleteActivityInputSchema,
    },
    (input) =>
      runTool('delete_activity', async () => {
        const { id, title } = await container.activityService.deleteActivity(input);
        return toolOk({ deleted: true, id, title });
      }),
  );
}
