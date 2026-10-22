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

  createFromActivity(input: CreateTaskFromActivityInput): Task {
    return this.tasks.create({
      projectId: input.projectId,
      activityId: input.activityId,
      title: input.title,
      description: input.description,
      status: input.blocked ? 'blocked' : 'open',
      priority: 'normal',
    });
  }

  listOpenAndBlocked(projectId: string, limit: number): { open: Task[]; blocked: Task[] } {
    return {
      open: this.tasks.listByStatuses(projectId, ['open', 'in_progress'], limit),
      blocked: this.tasks.listByStatuses(projectId, ['blocked'], limit),
    };
  }

  countAll(): number {
    return this.tasks.countAll();
  }
}
