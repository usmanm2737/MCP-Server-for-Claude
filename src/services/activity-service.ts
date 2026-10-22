import type { MemoryDatabase } from '../db/client.js';
import type { ProjectRepository } from '../db/repositories/project-repository.js';
import type { SessionRepository } from '../db/repositories/session-repository.js';
import type { ActivityRepository } from '../db/repositories/activity-repository.js';
import type { DecisionRepository } from '../db/repositories/decision-repository.js';
import type { TaskService } from './task-service.js';
import type { Activity, Project } from '../domain/models.js';
import type {
  DeleteActivityInput,
  GetRecentActivityInput,
  SaveActivityInput,
} from '../domain/schemas.js';
import { contentHash } from '../utils/ids.js';
import { NotFoundError } from '../utils/errors.js';

/** `SaveActivityInput` without `projectName` — the project is already resolved by the caller. */
export type SaveActivityForProjectInput = Omit<SaveActivityInput, 'projectName'>;

const DEFAULT_SOURCE = 'claude-code';

/**
 * Activity-type conventions used to fan a saved activity out into the
 * Decision/Task tables, documented for callers in each tool's description
 * and in CLAUDE.md. There is no separate "create_decision"/"create_task"
 * tool — `save_activity` is the single write path, and these two
 * `activityType` values are what populate those tables.
 */
const DECISION_ACTIVITY_TYPE = 'decision';
const TASK_ACTIVITY_TYPES = new Set(['task', 'blocker']);

export interface SaveActivityResult {
  activity: Activity;
  duplicate: boolean;
}

export class ActivityService {
  constructor(
    private readonly db: MemoryDatabase,
    private readonly projects: ProjectRepository,
    private readonly sessions: SessionRepository,
    private readonly activities: ActivityRepository,
    private readonly decisions: DecisionRepository,
    private readonly tasks: TaskService,
    private readonly maxResults: number,
  ) {}

  saveActivity(input: SaveActivityInput): SaveActivityResult {
    return this.db.transaction(() => {
      const project = this.projects.getOrCreate(input.projectName);
      return this.persistActivityForProject(project, input);
    });
  }

  /** Same persistence/dedup/fan-out logic as `saveActivity`, for a caller that already has a `Project` (e.g. the HTTP route resolving by id, which must 404 rather than auto-create). */
  saveActivityForProject(project: Project, input: SaveActivityForProjectInput): SaveActivityResult {
    return this.db.transaction(() => this.persistActivityForProject(project, input));
  }

  /** As `saveActivityForProject`, resolving the project by id first — throws `NotFoundError` for an unknown id rather than creating one. Used by the HTTP `POST /api/v1/projects/:projectId/activities` route. */
  saveActivityForProjectId(
    projectId: string,
    input: SaveActivityForProjectInput,
  ): SaveActivityResult {
    const project = this.projects.requireById(projectId);
    return this.saveActivityForProject(project, input);
  }

  private persistActivityForProject(
    project: Project,
    input: SaveActivityForProjectInput,
  ): SaveActivityResult {
    const source = input.source ?? DEFAULT_SOURCE;

    const session = input.sessionId
      ? this.sessions.getOrCreateByExternalId({
          projectId: project.id,
          source,
          externalSessionId: input.sessionId,
        })
      : null;

    const hash = contentHash([
      project.id,
      input.activityType,
      input.title,
      input.summary,
      input.content,
    ]);

    const existing = this.activities.findByContentHash(project.id, hash);
    if (existing) {
      return { activity: existing, duplicate: true };
    }

    const activity = this.activities.create({
      projectId: project.id,
      sessionId: session?.id ?? null,
      source,
      activityType: input.activityType,
      title: input.title,
      summary: input.summary,
      content: input.content ?? null,
      contentHash: hash,
      metadata: input.metadata,
      tags: input.tags,
    });

    const typeKey = input.activityType.trim().toLowerCase();
    if (typeKey === DECISION_ACTIVITY_TYPE) {
      this.decisions.create({
        projectId: project.id,
        activityId: activity.id,
        decision: input.title,
        rationale: input.content ?? input.summary,
      });
    } else if (TASK_ACTIVITY_TYPES.has(typeKey)) {
      this.tasks.createFromActivity({
        projectId: project.id,
        activityId: activity.id,
        title: input.title,
        description: input.summary,
        blocked: typeKey === 'blocker',
      });
    }

    return { activity, duplicate: false };
  }

  getRecentActivity(input: GetRecentActivityInput): { activities: Activity[]; note?: string } {
    let projectId: string | undefined;
    if (input.projectName) {
      const project = this.projects.findByName(input.projectName);
      if (!project) {
        return { activities: [], note: `No project named "${input.projectName}" exists.` };
      }
      projectId = project.id;
    }
    const limit = Math.min(input.limit ?? 20, this.maxResults);
    const activities = this.activities.listRecent({
      projectId,
      activityType: input.activityType,
      limit,
    });
    return { activities };
  }

  deleteActivity(input: DeleteActivityInput): { id: string; title: string } {
    const existing = this.activities.findById(input.activityId);
    if (!existing) {
      throw new NotFoundError('Activity', input.activityId);
    }
    this.activities.delete(input.activityId);
    return { id: existing.id, title: existing.title };
  }
}
