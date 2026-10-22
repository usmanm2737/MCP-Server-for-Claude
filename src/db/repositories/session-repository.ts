import type { MemoryDatabase } from '../client.js';
import type { Session } from '../../domain/models.js';
import { newId, nowIso } from '../../utils/ids.js';

interface SessionRow {
  id: string;
  project_id: string;
  source: string;
  external_session_id: string | null;
  title: string | null;
  started_at: string | null;
  ended_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

function mapRow(row: SessionRow): Session {
  return {
    id: row.id,
    projectId: row.project_id,
    source: row.source,
    externalSessionId: row.external_session_id,
    title: row.title,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

export interface CreateSessionInput {
  projectId: string;
  source: string;
  externalSessionId?: string | null;
  title?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  metadata?: Record<string, unknown>;
}

export class SessionRepository {
  constructor(private readonly db: MemoryDatabase) {}

  async findById(id: string): Promise<Session | null> {
    const row = await this.db.queryOne<SessionRow>('SELECT * FROM sessions WHERE id = $1', [id]);
    return row ? mapRow(row) : null;
  }

  async findByExternalId(projectId: string, externalSessionId: string): Promise<Session | null> {
    const row = await this.db.queryOne<SessionRow>(
      'SELECT * FROM sessions WHERE project_id = $1 AND external_session_id = $2',
      [projectId, externalSessionId],
    );
    return row ? mapRow(row) : null;
  }

  async create(input: CreateSessionInput): Promise<Session> {
    const id = newId();
    const createdAt = nowIso();
    await this.db.query(
      `INSERT INTO sessions (id, project_id, source, external_session_id, title, started_at, ended_at, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        input.projectId,
        input.source,
        input.externalSessionId ?? null,
        input.title ?? null,
        input.startedAt ?? null,
        input.endedAt ?? null,
        JSON.stringify(input.metadata ?? {}),
        createdAt,
      ],
    );
    return {
      id,
      projectId: input.projectId,
      source: input.source,
      externalSessionId: input.externalSessionId ?? null,
      title: input.title ?? null,
      startedAt: input.startedAt ?? null,
      endedAt: input.endedAt ?? null,
      metadata: input.metadata ?? {},
      createdAt,
    };
  }

  /**
   * Reuses the session for this (project, externalSessionId) pair if one
   * exists, else creates one. There's a small race window under genuine
   * concurrency (no unique constraint backs this — two near-simultaneous
   * imports of the same external session could each create a row); the
   * worst case is a harmless duplicate session, not corrupted data, so this
   * is left as a known, accepted edge case rather than adding a partial
   * unique index for it.
   */
  async getOrCreateByExternalId(input: CreateSessionInput): Promise<Session> {
    if (input.externalSessionId) {
      const existing = await this.findByExternalId(input.projectId, input.externalSessionId);
      if (existing) return existing;
    }
    return this.create(input);
  }

  async count(): Promise<number> {
    const row = await this.db.queryOne<{ n: number }>('SELECT COUNT(*)::int AS n FROM sessions');
    return row?.n ?? 0;
  }
}
