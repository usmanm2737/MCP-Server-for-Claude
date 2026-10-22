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
    private readonly dbPath: string,
    private readonly schemaVersionFn: () => number,
  ) {}

  /**
   * Persists the project's new state and leaves a `state-update` activity
   * behind so the change shows up in `get_recent_activity`/`search_activity`
   * too. Both writes happen in one transaction; unrelated project columns
   * (description, id, timestestamps aside from updated_at) are untouched.
   */
  updateProjectState(input: UpdateProjectStateInput): Project {
    return this.db.transaction(() => {
      const project = this.projects.getOrCreate(input.projectName);
      const updated = this.projects.updateState(project.id, input.currentState, input.nextSteps);

      const hash = contentHash([
        project.id,
        STATE_UPDATE_ACTIVITY_TYPE,
        input.currentState,
        input.nextSteps,
        input.notes,
      ]);
      if (!this.activities.findByContentHash(project.id, hash)) {
        this.activities.create({
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
  listProjects(limit: number): Project[] {
    return this.projects.list(limit);
  }

  getMemoryStats(): MemoryStats {
    let ftsIndexOk = true;
    try {
      this.db.raw
        .prepare("INSERT INTO activities_fts(activities_fts) VALUES('integrity-check')")
        .run();
    } catch {
      ftsIndexOk = false;
    }

    return {
      schemaVersion: this.schemaVersionFn(),
      dbPath: this.dbPath,
      counts: {
        projects: this.projects.count(),
        sessions: this.sessions.count(),
        activities: this.activities.countAll(),
        decisions: this.decisions.countAll(),
        tasks: this.tasks.countAll(),
      },
      oldestActivityAt: this.activities.oldestCreatedAt(),
      newestActivityAt: this.activities.newestCreatedAt(),
      ftsIndexOk,
    };
  }
}
