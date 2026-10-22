import type { ProjectRepository } from '../db/repositories/project-repository.js';
import type { ActivityRepository } from '../db/repositories/activity-repository.js';
import type { DecisionRepository } from '../db/repositories/decision-repository.js';
import type { TaskService } from './task-service.js';
import type { GetProjectContextInput } from '../domain/schemas.js';
import type { ProjectContext } from '../domain/models.js';

const DEFAULT_MAX_ITEMS = 10;

export class ContextService {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly activities: ActivityRepository,
    private readonly decisions: DecisionRepository,
    private readonly tasks: TaskService,
  ) {}

  /** Project names, most recently updated first — backs the project-context resource listing. */
  listProjectNames(limit: number): string[] {
    return this.projects.listNames(limit);
  }

  /** Throws `NotFoundError` for an unknown project — reading context never auto-creates one. */
  getProjectContext(input: GetProjectContextInput): ProjectContext {
    const project = this.projects.requireByName(input.projectName);
    const maxItems = input.maxItems ?? DEFAULT_MAX_ITEMS;

    const recentActivities = this.activities
      .listRecent({ projectId: project.id, limit: maxItems })
      // Bounded summaries, not an unlimited transcript: drop the full `content` body here.
      .map((activity) => ({ ...activity, content: null }));

    const decisions = this.decisions.listRelevant(project.id, maxItems);
    const { open, blocked } = this.tasks.listOpenAndBlocked(project.id, maxItems);

    return {
      project: {
        id: project.id,
        name: project.name,
        description: project.description,
        currentState: project.currentState,
        nextSteps: project.nextSteps,
        updatedAt: project.updatedAt,
      },
      recentActivities,
      decisions,
      openTasks: open,
      blockedTasks: blocked,
    };
  }
}
