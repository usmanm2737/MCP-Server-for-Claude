import { McpServer } from '@modelcontextprotocol/server';

import type { Container } from '../container.js';
import { registerActivityTools } from './tools/activities.js';
import { registerProjectTools } from './tools/projects.js';
import { registerImportTools } from './tools/imports.js';
import { registerProjectContextResource } from './resources/project-context.js';
import { registerResumeProjectPrompt } from './prompts/resume-project.js';

export const SERVER_NAME = 'claude-activity-memory';
export const SERVER_VERSION = '0.1.0';

/** Builds one `McpServer` with all tools/resources/prompts registered over `container`. Transport-agnostic. */
export function createMcpServer(container: Container): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  registerActivityTools(server, container);
  registerProjectTools(server, container);
  registerImportTools(server, container);
  registerProjectContextResource(server, container);
  registerResumeProjectPrompt(server);

  return server;
}
