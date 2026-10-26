/**
 * Migration 2: user-defined (saved-at-runtime) prompts and resources.
 *
 * Lets a connected client persist a prompt template or a chunk of resource
 * content via a tool call, instead of only the two hardcoded ones
 * (`resume_project` prompt, `project-context` resource) wired at build time.
 * `name` is the slugified, unique identifier used both as the MCP
 * prompt/tool name and as the `memory://custom/{name}` resource URI
 * segment; `title` is the free-text display label.
 */
import type { Migration } from '../client.js';

export const migration0002CustomPromptsResources: Migration = {
  version: 2,
  name: 'custom_prompts_resources',
  up: [
    `CREATE TABLE custom_prompts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      title TEXT,
      description TEXT,
      template TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE custom_resources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      title TEXT,
      description TEXT,
      content TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'text/plain',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  ],
};
