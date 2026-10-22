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

  findById(id: string): Task | null {
    const row = this.db.raw.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as unknown as
      TaskRow | undefined;
    return row ? mapRow(row) : null;
  }

  create(input: CreateTaskInput): Task {
    const id = newId();
    const ts = nowIso();
    const status = input.status ?? 'open';
    const priority = input.priority ?? 'normal';
    this.db.raw
      .prepare(
        `INSERT INTO tasks (id, project_id, activity_id, title, description, status, priority, created_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        id,
        input.projectId,
        input.activityId ?? null,
        input.title,
        input.description ?? null,
        status,
        priority,
        ts,
        ts,
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

  listByStatuses(projectId: string, statuses: TaskStatus[], limit: number): Task[] {
    const placeholders = statuses.map(() => '?').join(', ');
    const rows = this.db.raw
      .prepare(
        `SELECT * FROM tasks
         WHERE project_id = ? AND status IN (${placeholders})
         ORDER BY
           CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
           created_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(projectId, ...statuses, limit) as unknown as TaskRow[];
    return rows.map(mapRow);
  }

  countAll(): number {
    const row = this.db.raw.prepare('SELECT COUNT(*) AS n FROM tasks').get() as unknown as {
      n: number;
    };
    return row.n;
  }
}
