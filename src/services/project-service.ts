import type { MemoryDatabase } from '../db/client.js';
import type { ProjectRepository } from '../db/repositories/project-repository.js';
import type { SessionRepository } from '../db/repositories/session-repository.js';
import type { ActivityRepository } from '../db/repositories/activity-repository.js';
import type { DecisionRepository } from '../db/repositories/decision-repository.js';
import type { TaskService } from './task-service.js';
import type { Project, MemoryStats } from '../domain/models.js';
import type { UpdateProjectStateInput } from '../domain/schemas.js';
import { contentHash } from '../utils/ids.js';

const STATE_UPDATE_ACTIVITY_TYPE = 'state-update';

export class ProjectService {
  constructor(
    private readonly db: MemoryDatabase,
    private readonly projects: ProjectRepository,
    private readonly sessions: SessionRepository,
    private readonly activities: ActivityRepository,
    private readonly decisions: DecisionRepository,
    private readonly tasks: TaskService,
    /** Host/database only — never the raw connection string, which carries credentials. See `redactConnectionString` in `config/env.ts`. */
    private readonly dbDisplayName: string,
    private readonly schemaVersionFn: () => Promise<number>,
  ) {}

  /**
   * Persists the project's new state and leaves a `state-update` activity
   * behind so the change shows up in `get_recent_activity`/`search_activity`
   * too. Both writes happen in one transaction; unrelated project columns
   * (description, id, timestestamps aside from updated_at) are untouched.
   */
  async updateProjectState(input: UpdateProjectStateInput): Promise<Project> {
    return this.db.transaction(async () => {
      const project = await this.projects.getOrCreate(input.projectName);
      const updated = await this.projects.updateState(
        project.id,
        input.currentState,
        input.nextSteps,
      );

      const hash = contentHash([
        project.id,
        STATE_UPDATE_ACTIVITY_TYPE,
        input.currentState,
        input.nextSteps,
        input.notes,
      ]);
      if (!(await this.activities.findByContentHash(project.id, hash))) {
        await this.activities.create({
          projectId: project.id,
          source: 'claude-code',
          activityType: STATE_UPDATE_ACTIVITY_TYPE,
          title: 'Project state updated',
          summary: input.notes?.slice(0, 300) ?? input.currentState.slice(0, 300),
          content: input.notes ?? null,
          contentHash: hash,
        });
      }

      return updated;
    });
  }

  /** Full project rows, most recently updated first — used by the HTTP `GET /api/v1/projects` route. */
  async listProjects(limit: number): Promise<Project[]> {
    return this.projects.list(limit);
  }

  async getMemoryStats(): Promise<MemoryStats> {
    let searchOk = true;
    try {
      await this.db.query(
        "SELECT 1 FROM activities WHERE search_vector @@ websearch_to_tsquery('english', 'health-check-probe') LIMIT 1",
      );
    } catch {
      searchOk = false;
    }

    const [projectCount, sessionCount, activityCount, decisionCount, taskCount, oldest, newest] =
      await Promise.all([
        this.projects.count(),
        this.sessions.count(),
        this.activities.countAll(),
        this.decisions.countAll(),
        this.tasks.countAll(),
        this.activities.oldestCreatedAt(),
        this.activities.newestCreatedAt(),
      ]);

    return {
      schemaVersion: await this.schemaVersionFn(),
      dbPath: this.dbDisplayName,
      counts: {
        projects: projectCount,
        sessions: sessionCount,
        activities: activityCount,
        decisions: decisionCount,
        tasks: taskCount,
      },
      oldestActivityAt: oldest,
      newestActivityAt: newest,
      ftsIndexOk: searchOk,
    };
  }
}
