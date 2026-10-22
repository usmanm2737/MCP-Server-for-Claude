import type { MemoryDatabase } from '../client.js';
import type { Decision, DecisionStatus } from '../../domain/models.js';
import { newId, nowIso } from '../../utils/ids.js';

interface DecisionRow {
  id: string;
  project_id: string;
  activity_id: string | null;
  decision: string;
  rationale: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

function mapRow(row: DecisionRow): Decision {
  return {
    id: row.id,
    projectId: row.project_id,
    activityId: row.activity_id,
    decision: row.decision,
    rationale: row.rationale,
    status: row.status as DecisionStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateDecisionInput {
  projectId: string;
  activityId?: string | null;
  decision: string;
  rationale?: string | null;
  status?: DecisionStatus;
}

export class DecisionRepository {
  constructor(private readonly db: MemoryDatabase) {}

  findById(id: string): Decision | null {
    const row = this.db.raw.prepare('SELECT * FROM decisions WHERE id = ?').get(id) as unknown as
      DecisionRow | undefined;
    return row ? mapRow(row) : null;
  }

  create(input: CreateDecisionInput): Decision {
    const id = newId();
    const ts = nowIso();
    const status = input.status ?? 'active';
    this.db.raw
      .prepare(
        `INSERT INTO decisions (id, project_id, activity_id, decision, rationale, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        input.activityId ?? null,
        input.decision,
        input.rationale ?? null,
        status,
        ts,
        ts,
      );
    return {
      id,
      projectId: input.projectId,
      activityId: input.activityId ?? null,
      decision: input.decision,
      rationale: input.rationale ?? null,
      status,
      createdAt: ts,
      updatedAt: ts,
    };
  }

  /** Recent, non-reverted decisions for a project — used by project context. */
  listRelevant(projectId: string, limit: number): Decision[] {
    const rows = this.db.raw
      .prepare(
        `SELECT * FROM decisions
         WHERE project_id = ? AND status != 'reverted'
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(projectId, limit) as unknown as DecisionRow[];
    return rows.map(mapRow);
  }

  countAll(): number {
    const row = this.db.raw.prepare('SELECT COUNT(*) AS n FROM decisions').get() as unknown as {
      n: number;
    };
    return row.n;
  }
}
