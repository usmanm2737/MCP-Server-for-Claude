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
  metadata_json: string;
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
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
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

  findById(id: string): Session | null {
    const row = this.db.raw.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as unknown as
      SessionRow | undefined;
    return row ? mapRow(row) : null;
  }

  findByExternalId(projectId: string, externalSessionId: string): Session | null {
    const row = this.db.raw
      .prepare('SELECT * FROM sessions WHERE project_id = ? AND external_session_id = ?')
      .get(projectId, externalSessionId) as unknown as SessionRow | undefined;
    return row ? mapRow(row) : null;
  }

  create(input: CreateSessionInput): Session {
    const id = newId();
    const createdAt = nowIso();
    this.db.raw
      .prepare(
        `INSERT INTO sessions (id, project_id, source, external_session_id, title, started_at, ended_at, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        input.source,
        input.externalSessionId ?? null,
        input.title ?? null,
        input.startedAt ?? null,
        input.endedAt ?? null,
        JSON.stringify(input.metadata ?? {}),
        createdAt,
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

  /** Reuses the session for this (project, externalSessionId) pair if one exists, else creates one. */
  getOrCreateByExternalId(input: CreateSessionInput): Session {
    if (input.externalSessionId) {
      const existing = this.findByExternalId(input.projectId, input.externalSessionId);
      if (existing) return existing;
    }
    return this.create(input);
  }

  count(): number {
    const row = this.db.raw.prepare('SELECT COUNT(*) AS n FROM sessions').get() as unknown as {
      n: number;
    };
    return row.n;
  }
}
