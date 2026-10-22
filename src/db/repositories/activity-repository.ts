import type { SQLInputValue } from 'node:sqlite';

import type { MemoryDatabase } from '../client.js';
import type { Activity } from '../../domain/models.js';
import { newId, nowIso } from '../../utils/ids.js';

interface ActivityRow {
  id: string;
  project_id: string;
  session_id: string | null;
  source: string;
  activity_type: string;
  title: string;
  summary: string;
  content: string | null;
  source_reference: string | null;
  content_hash: string;
  metadata_json: string;
  created_at: string;
  imported_at: string;
}

export interface CreateActivityInput {
  projectId: string;
  sessionId?: string | null;
  source: string;
  activityType: string;
  title: string;
  summary: string;
  content?: string | null;
  sourceReference?: string | null;
  contentHash: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
}

export interface ListActivitiesFilter {
  projectId?: string;
  activityType?: string;
  limit: number;
}

function mapRow(row: ActivityRow, tags: string[]): Activity {
  return {
    id: row.id,
    projectId: row.project_id,
    sessionId: row.session_id,
    source: row.source,
    activityType: row.activity_type,
    title: row.title,
    summary: row.summary,
    content: row.content,
    sourceReference: row.source_reference,
    contentHash: row.content_hash,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    tags,
    createdAt: row.created_at,
    importedAt: row.imported_at,
  };
}

export class ActivityRepository {
  constructor(private readonly db: MemoryDatabase) {}

  private tagsFor(activityId: string): string[] {
    const rows = this.db.raw
      .prepare(
        `SELECT t.name AS name
         FROM activity_tags at
         JOIN tags t ON t.id = at.tag_id
         WHERE at.activity_id = ?
         ORDER BY t.name`,
      )
      .all(activityId) as unknown as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  private ensureTagIds(names: string[]): number[] {
    const ids: number[] = [];
    for (const rawName of names) {
      const name = rawName.trim().toLowerCase();
      if (!name) continue;
      this.db.raw.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(name);
      const row = this.db.raw
        .prepare('SELECT id FROM tags WHERE name = ?')
        .get(name) as unknown as {
        id: number;
      };
      ids.push(row.id);
    }
    return ids;
  }

  findById(id: string): Activity | null {
    const row = this.db.raw.prepare('SELECT * FROM activities WHERE id = ?').get(id) as unknown as
      ActivityRow | undefined;
    return row ? mapRow(row, this.tagsFor(row.id)) : null;
  }

  findByContentHash(projectId: string, contentHash: string): Activity | null {
    const row = this.db.raw
      .prepare('SELECT * FROM activities WHERE project_id = ? AND content_hash = ?')
      .get(projectId, contentHash) as unknown as ActivityRow | undefined;
    return row ? mapRow(row, this.tagsFor(row.id)) : null;
  }

  /**
   * Inserts the activity row, its FTS index entry, and its tag links as one
   * atomic unit (via `db.transaction`, which joins a caller's outer
   * transaction if there is one). Throws the underlying SQLite constraint
   * error on a duplicate `(project_id, content_hash)` — callers that treat
   * duplicates as a soft "skip" should check `findByContentHash` first.
   */
  create(input: CreateActivityInput): Activity {
    return this.db.transaction(() => {
      const id = newId();
      const createdAt = nowIso();
      const importedAt = createdAt;
      const metadataJson = JSON.stringify(input.metadata ?? {});

      this.db.raw
        .prepare(
          `INSERT INTO activities
             (id, project_id, session_id, source, activity_type, title, summary, content,
              source_reference, content_hash, metadata_json, created_at, imported_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.projectId,
          input.sessionId ?? null,
          input.source,
          input.activityType,
          input.title,
          input.summary,
          input.content ?? null,
          input.sourceReference ?? null,
          input.contentHash,
          metadataJson,
          createdAt,
          importedAt,
        );

      this.db.raw
        .prepare(
          `INSERT INTO activities_fts (activity_id, project_id, title, summary, content)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, input.projectId, input.title, input.summary, input.content ?? '');

      const tagNames = input.tags ?? [];
      if (tagNames.length > 0) {
        const tagIds = this.ensureTagIds(tagNames);
        const insertLink = this.db.raw.prepare(
          'INSERT OR IGNORE INTO activity_tags (activity_id, tag_id) VALUES (?, ?)',
        );
        for (const tagId of tagIds) insertLink.run(id, tagId);
      }

      return mapRow(
        {
          id,
          project_id: input.projectId,
          session_id: input.sessionId ?? null,
          source: input.source,
          activity_type: input.activityType,
          title: input.title,
          summary: input.summary,
          content: input.content ?? null,
          source_reference: input.sourceReference ?? null,
          content_hash: input.contentHash,
          metadata_json: metadataJson,
          created_at: createdAt,
          imported_at: importedAt,
        },
        tagNames.map((t) => t.trim().toLowerCase()).filter(Boolean),
      );
    });
  }

  /** Deletes the activity, its tag links, and its FTS entry. Returns false if no such activity existed. */
  delete(id: string): boolean {
    return this.db.transaction(() => {
      const existing = this.db.raw.prepare('SELECT 1 FROM activities WHERE id = ?').get(id);
      if (!existing) return false;
      this.db.raw.prepare('DELETE FROM activity_tags WHERE activity_id = ?').run(id);
      this.db.raw.prepare('DELETE FROM activities_fts WHERE activity_id = ?').run(id);
      this.db.raw.prepare('DELETE FROM activities WHERE id = ?').run(id);
      return true;
    });
  }

  listRecent(filter: ListActivitiesFilter): Activity[] {
    const clauses: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.projectId) {
      clauses.push('project_id = ?');
      params.push(filter.projectId);
    }
    if (filter.activityType) {
      clauses.push('activity_type = ?');
      params.push(filter.activityType);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(filter.limit);
    // `rowid` (SQLite's implicit, monotonically-increasing row identifier — available
    // because `activities` has a TEXT primary key, not an INTEGER one, so it doesn't
    // alias rowid) breaks created_at ties in actual insertion order; `id` (a random
    // uuid) would not, since it carries no ordering information at all.
    const rows = this.db.raw
      .prepare(`SELECT * FROM activities ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(...params) as unknown as ActivityRow[];
    return rows.map((row) => mapRow(row, this.tagsFor(row.id)));
  }

  countAll(): number {
    const row = this.db.raw.prepare('SELECT COUNT(*) AS n FROM activities').get() as unknown as {
      n: number;
    };
    return row.n;
  }

  oldestCreatedAt(): string | null {
    const row = this.db.raw
      .prepare('SELECT MIN(created_at) AS v FROM activities')
      .get() as unknown as {
      v: string | null;
    };
    return row.v;
  }

  newestCreatedAt(): string | null {
    const row = this.db.raw
      .prepare('SELECT MAX(created_at) AS v FROM activities')
      .get() as unknown as {
      v: string | null;
    };
    return row.v;
  }
}
