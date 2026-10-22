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
  metadata: Record<string, unknown>;
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
    metadata: row.metadata,
    tags,
    createdAt: row.created_at,
    importedAt: row.imported_at,
  };
}

export class ActivityRepository {
  constructor(private readonly db: MemoryDatabase) {}

  private async tagsFor(activityId: string): Promise<string[]> {
    const rows = await this.db.query<{ name: string }>(
      `SELECT t.name AS name
       FROM activity_tags atg
       JOIN tags t ON t.id = atg.tag_id
       WHERE atg.activity_id = $1
       ORDER BY t.name`,
      [activityId],
    );
    return rows.map((r) => r.name);
  }

  private async ensureTagIds(names: string[]): Promise<number[]> {
    const ids: number[] = [];
    for (const rawName of names) {
      const name = rawName.trim().toLowerCase();
      if (!name) continue;
      // ON CONFLICT DO UPDATE (rather than DO NOTHING) so RETURNING always yields
      // the row's id, whether this call just inserted it or it already existed.
      const row = await this.db.queryOne<{ id: number }>(
        `INSERT INTO tags (name) VALUES ($1)
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [name],
      );
      if (row) ids.push(row.id);
    }
    return ids;
  }

  async findById(id: string): Promise<Activity | null> {
    const row = await this.db.queryOne<ActivityRow>('SELECT * FROM activities WHERE id = $1', [id]);
    return row ? mapRow(row, await this.tagsFor(row.id)) : null;
  }

  async findByContentHash(projectId: string, contentHash: string): Promise<Activity | null> {
    const row = await this.db.queryOne<ActivityRow>(
      'SELECT * FROM activities WHERE project_id = $1 AND content_hash = $2',
      [projectId, contentHash],
    );
    return row ? mapRow(row, await this.tagsFor(row.id)) : null;
  }

  /**
   * Inserts the activity row and its tag links as one atomic unit (via
   * `db.transaction`, which joins a caller's outer transaction — as a
   * `SAVEPOINT` — if there is one). The full-text search vector is
   * maintained by Postgres itself (a generated column), not by this method.
   * Throws the underlying unique-constraint error on a duplicate
   * `(project_id, content_hash)` — callers that treat duplicates as a soft
   * "skip" should check `findByContentHash` first.
   */
  async create(input: CreateActivityInput): Promise<Activity> {
    return this.db.transaction(async () => {
      const id = newId();
      const createdAt = nowIso();
      const importedAt = createdAt;
      const metadata = input.metadata ?? {};

      await this.db.query(
        `INSERT INTO activities
           (id, project_id, session_id, source, activity_type, title, summary, content,
            source_reference, content_hash, metadata, created_at, imported_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
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
          JSON.stringify(metadata),
          createdAt,
          importedAt,
        ],
      );

      const tagNames = input.tags ?? [];
      if (tagNames.length > 0) {
        const tagIds = await this.ensureTagIds(tagNames);
        for (const tagId of tagIds) {
          await this.db.query(
            'INSERT INTO activity_tags (activity_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [id, tagId],
          );
        }
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
          metadata,
          created_at: createdAt,
          imported_at: importedAt,
        },
        tagNames.map((t) => t.trim().toLowerCase()).filter(Boolean),
      );
    });
  }

  /** Deletes the activity and its tag links. Returns false if no such activity existed. */
  async delete(id: string): Promise<boolean> {
    return this.db.transaction(async () => {
      const existing = await this.db.queryOne('SELECT 1 FROM activities WHERE id = $1', [id]);
      if (!existing) return false;
      await this.db.query('DELETE FROM activity_tags WHERE activity_id = $1', [id]);
      await this.db.query('DELETE FROM activities WHERE id = $1', [id]);
      return true;
    });
  }

  async listRecent(filter: ListActivitiesFilter): Promise<Activity[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.projectId) {
      clauses.push(`project_id = $${params.length + 1}`);
      params.push(filter.projectId);
    }
    if (filter.activityType) {
      clauses.push(`activity_type = $${params.length + 1}`);
      params.push(filter.activityType);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(filter.limit);
    const rows = await this.db.query<ActivityRow>(
      `SELECT * FROM activities ${where} ORDER BY created_at DESC, seq DESC LIMIT $${params.length}`,
      params,
    );
    return Promise.all(rows.map(async (row) => mapRow(row, await this.tagsFor(row.id))));
  }

  async countAll(): Promise<number> {
    const row = await this.db.queryOne<{ n: number }>('SELECT COUNT(*)::int AS n FROM activities');
    return row?.n ?? 0;
  }

  async oldestCreatedAt(): Promise<string | null> {
    const row = await this.db.queryOne<{ v: string | null }>(
      'SELECT MIN(created_at) AS v FROM activities',
    );
    return row?.v ?? null;
  }

  async newestCreatedAt(): Promise<string | null> {
    const row = await this.db.queryOne<{ v: string | null }>(
      'SELECT MAX(created_at) AS v FROM activities',
    );
    return row?.v ?? null;
  }
}
