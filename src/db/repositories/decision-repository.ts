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

  async findById(id: string): Promise<Decision | null> {
    const row = await this.db.queryOne<DecisionRow>('SELECT * FROM decisions WHERE id = $1', [id]);
    return row ? mapRow(row) : null;
  }

  async create(input: CreateDecisionInput): Promise<Decision> {
    const id = newId();
    const ts = nowIso();
    const status = input.status ?? 'active';
    await this.db.query(
      `INSERT INTO decisions (id, project_id, activity_id, decision, rationale, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        input.projectId,
        input.activityId ?? null,
        input.decision,
        input.rationale ?? null,
        status,
        ts,
        ts,
      ],
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
  async listRelevant(projectId: string, limit: number): Promise<Decision[]> {
    const rows = await this.db.query<DecisionRow>(
      `SELECT * FROM decisions
       WHERE project_id = $1 AND status != 'reverted'
       ORDER BY created_at DESC, seq DESC
       LIMIT $2`,
      [projectId, limit],
    );
    return rows.map(mapRow);
  }

  async countAll(): Promise<number> {
    const row = await this.db.queryOne<{ n: number }>('SELECT COUNT(*)::int AS n FROM decisions');
    return row?.n ?? 0;
  }
}
