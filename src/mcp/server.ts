import { McpServer } from '@modelcontextprotocol/server';

import type { Container } from '../container.js';
import { registerActivityTools } from './tools/activities.js';
import { registerProjectTools } from './tools/projects.js';
import { registerImportTools } from './tools/imports.js';
import { registerCustomContentTools } from './tools/custom-content.js';
import { registerProjectContextResource } from './resources/project-context.js';
import { registerSavedCustomResources } from './resources/custom-resources.js';
import { registerResumeProjectPrompt } from './prompts/resume-project.js';
import { registerSavedCustomPrompts } from './prompts/custom-prompts.js';

export const SERVER_NAME = 'claude-activity-memory';
export const SERVER_VERSION = '0.1.0';

/** Builds one `McpServer` with all tools/resources/prompts registered over `container`. Transport-agnostic. */
export function createMcpServer(container: Container): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  registerActivityTools(server, container);
  registerProjectTools(server, container);
  registerImportTools(server, container);
  registerCustomContentTools(server, container);
  registerProjectContextResource(server, container);
  registerResumeProjectPrompt(server);
  // Anything saved via save_prompt/save_resource — loaded fresh per session, after the
  // two built-in ones, so a saved name never silently shadows a built-in one at registration time.
  registerSavedCustomPrompts(server, container);
  registerSavedCustomResources(server, container);

  return server;
}
