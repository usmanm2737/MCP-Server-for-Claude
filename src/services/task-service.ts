import type { TaskRepository } from '../db/repositories/task-repository.js';
import type { Task } from '../domain/models.js';

export interface CreateTaskFromActivityInput {
  projectId: string;
  activityId: string;
  title: string;
  description: string;
  blocked: boolean;
}

/** Thin service wrapping `TaskRepository` so other services never touch task SQL directly. */
export class TaskService {
  constructor(private readonly tasks: TaskRepository) {}

  async createFromActivity(input: CreateTaskFromActivityInput): Promise<Task> {
    return this.tasks.create({
      projectId: input.projectId,
      activityId: input.activityId,
      title: input.title,
      description: input.description,
      status: input.blocked ? 'blocked' : 'open',
      priority: 'normal',
    });
  }

  async listOpenAndBlocked(
    projectId: string,
    limit: number,
  ): Promise<{ open: Task[]; blocked: Task[] }> {
    const [open, blocked] = await Promise.all([
      this.tasks.listByStatuses(projectId, ['open', 'in_progress'], limit),
      this.tasks.listByStatuses(projectId, ['blocked'], limit),
    ]);
    return { open, blocked };
  }

  async countAll(): Promise<number> {
    return this.tasks.countAll();
  }
}
