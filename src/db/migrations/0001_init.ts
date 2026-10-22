/**
 * Migration 1: initial schema (Postgres dialect).
 *
 * Migrations are embedded as TypeScript modules (not loose `.sql` files) so
 * the compiled `dist/` output always carries them. Each migration's `up` is
 * an array of statements applied one-by-one inside one transaction by the
 * runner in `../client.ts`. Once released, a migration's SQL must not
 * change; ship a new migration file to alter schema further.
 *
 * Full-text search uses a generated `tsvector` column + GIN index on
 * `activities` (via `websearch_to_tsquery` at query time — see
 * `search-service.ts`) instead of SQLite's FTS5 virtual table. The generated
 * column is maintained by Postgres itself on every INSERT/UPDATE, so there is
 * no separate index table to keep in sync by hand.
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
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX idx_sessions_project_id ON sessions(project_id)`,
    `CREATE INDEX idx_sessions_external_id ON sessions(external_session_id)`,
    `CREATE TABLE activities (
      id TEXT PRIMARY KEY,
      -- Monotonically-increasing insertion-order tiebreaker for "most recent first"
      -- listings. Postgres has no SQLite-style stable rowid to lean on (its physical
      -- ctid isn't stable across updates/vacuum), and created_at alone only has
      -- millisecond precision, which a fast import loop can collide on.
      seq BIGSERIAL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      source TEXT NOT NULL,
      activity_type TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      content TEXT,
      source_reference TEXT,
      content_hash TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      UNIQUE (project_id, content_hash)
    )`,
    `CREATE INDEX idx_activities_project_id ON activities(project_id)`,
    `CREATE INDEX idx_activities_session_id ON activities(session_id)`,
    `CREATE INDEX idx_activities_created_at ON activities(created_at)`,
    `CREATE INDEX idx_activities_type ON activities(project_id, activity_type)`,
    `ALTER TABLE activities ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
      setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
      setweight(to_tsvector('english', coalesce(summary, '')), 'B') ||
      setweight(to_tsvector('english', coalesce(content, '')), 'C')
    ) STORED`,
    `CREATE INDEX idx_activities_search_vector ON activities USING GIN (search_vector)`,
    `CREATE TABLE decisions (
      id TEXT PRIMARY KEY,
      seq BIGSERIAL,
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
      seq BIGSERIAL,
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
      id SERIAL PRIMARY KEY,
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
