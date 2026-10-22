/**
 * Migration 1: initial schema.
 *
 * Migrations are embedded as TypeScript modules (not loose `.sql` files) so
 * the compiled `dist/` output always carries them — no separate copy step
 * at build time. Each migration's `up` is an array of statements applied in
 * one transaction by the runner in `../client.ts`. Once released, a
 * migration's SQL must not change; ship a new migration file to alter
 * schema further.
 */
import type { Migration } from '../client.js';

export const migration0001Init: Migration = {
  version: 1,
  name: 'init',
  up: [
    `CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      slug TEXT NOT NULL UNIQUE,
      description TEXT,
      current_state TEXT,
      next_steps TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      external_session_id TEXT,
      title TEXT,
      started_at TEXT,
      ended_at TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX idx_sessions_project_id ON sessions(project_id)`,
    `CREATE INDEX idx_sessions_external_id ON sessions(external_session_id)`,
    `CREATE TABLE activities (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      source TEXT NOT NULL,
      activity_type TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      content TEXT,
      source_reference TEXT,
      content_hash TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      UNIQUE (project_id, content_hash)
    )`,
    `CREATE INDEX idx_activities_project_id ON activities(project_id)`,
    `CREATE INDEX idx_activities_session_id ON activities(session_id)`,
    `CREATE INDEX idx_activities_created_at ON activities(created_at)`,
    `CREATE INDEX idx_activities_type ON activities(project_id, activity_type)`,
    `CREATE VIRTUAL TABLE activities_fts USING fts5(
      activity_id UNINDEXED,
      project_id UNINDEXED,
      title,
      summary,
      content
    )`,
    `CREATE TABLE decisions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      activity_id TEXT REFERENCES activities(id) ON DELETE SET NULL,
      decision TEXT NOT NULL,
      rationale TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE INDEX idx_decisions_project_id ON decisions(project_id, status)`,
    `CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      activity_id TEXT REFERENCES activities(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      priority TEXT NOT NULL DEFAULT 'normal',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    )`,
    `CREATE INDEX idx_tasks_project_id_status ON tasks(project_id, status)`,
    `CREATE TABLE tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    )`,
    `CREATE TABLE project_tags (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (project_id, tag_id)
    )`,
    `CREATE TABLE activity_tags (
      activity_id TEXT NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (activity_id, tag_id)
    )`,
  ],
};
