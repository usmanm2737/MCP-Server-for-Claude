import type { MemoryDatabase } from '../client.js';
import type { Task, TaskPriority, TaskStatus } from '../../domain/models.js';
import { newId, nowIso } from '../../utils/ids.js';

interface TaskRow {
  id: string;
  project_id: string;
  activity_id: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function mapRow(row: TaskRow): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    activityId: row.activity_id,
    title: row.title,
    description: row.description,
    status: row.status as TaskStatus,
    priority: row.priority as TaskPriority,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

export interface CreateTaskInput {
  projectId: string;
  activityId?: string | null;
  title: string;
  description?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority;
}

export class TaskRepository {
  constructor(private readonly db: MemoryDatabase) {}

  async findById(id: string): Promise<Task | null> {
    const row = await this.db.queryOne<TaskRow>('SELECT * FROM tasks WHERE id = $1', [id]);
    return row ? mapRow(row) : null;
  }

  async create(input: CreateTaskInput): Promise<Task> {
    const id = newId();
    const ts = nowIso();
    const status = input.status ?? 'open';
    const priority = input.priority ?? 'normal';
    await this.db.query(
      `INSERT INTO tasks (id, project_id, activity_id, title, description, status, priority, created_at, updated_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL)`,
      [
        id,
        input.projectId,
        input.activityId ?? null,
        input.title,
        input.description ?? null,
        status,
        priority,
        ts,
        ts,
      ],
    );
    return {
      id,
      projectId: input.projectId,
      activityId: input.activityId ?? null,
      title: input.title,
      description: input.description ?? null,
      status,
      priority,
      createdAt: ts,
      updatedAt: ts,
      completedAt: null,
    };
  }

  async listByStatuses(projectId: string, statuses: TaskStatus[], limit: number): Promise<Task[]> {
    // `pg` serializes a JS array parameter to a Postgres array literal, so `= ANY($2)`
    // takes the place of building a manual `IN (?, ?, ...)` placeholder list.
    const rows = await this.db.query<TaskRow>(
      `SELECT * FROM tasks
       WHERE project_id = $1 AND status = ANY($2)
       ORDER BY
         CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
         created_at DESC, seq DESC
       LIMIT $3`,
      [projectId, statuses, limit],
    );
    return rows.map(mapRow);
  }

  async countAll(): Promise<number> {
    const row = await this.db.queryOne<{ n: number }>('SELECT COUNT(*)::int AS n FROM tasks');
    return row?.n ?? 0;
  }
}
