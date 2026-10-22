import type { AppConfig } from './config/env.js';
import { MemoryDatabase } from './db/client.js';
import { migrations } from './db/migrations/index.js';
import { ProjectRepository } from './db/repositories/project-repository.js';
import { SessionRepository } from './db/repositories/session-repository.js';
import { ActivityRepository } from './db/repositories/activity-repository.js';
import { DecisionRepository } from './db/repositories/decision-repository.js';
import { TaskRepository } from './db/repositories/task-repository.js';
import { ActivityService } from './services/activity-service.js';
import { ProjectService } from './services/project-service.js';
import { ContextService } from './services/context-service.js';
import { SearchService } from './services/search-service.js';
import { ImportService } from './services/import-service.js';
import { TaskService } from './services/task-service.js';

/**
 * Composition root: wires repositories and services over one open database.
 * Built once by the stdio/REST/remote-MCP entrypoints; tests build their own
 * via `buildContainerFromDb` over a shared real Postgres `MemoryDatabase`
 * (there's no "in-memory" mode for Postgres — see `tests/helpers.ts`).
 */
export interface Container {
  db: MemoryDatabase;
  config: AppConfig;
  activityService: ActivityService;
  projectService: ProjectService;
  contextService: ContextService;
  searchService: SearchService;
  importService: ImportService;
}

export function buildContainerFromDb(db: MemoryDatabase, config: AppConfig): Container {
  const projects = new ProjectRepository(db);
  const sessions = new SessionRepository(db);
  const activities = new ActivityRepository(db);
  const decisions = new DecisionRepository(db);
  const taskRepo = new TaskRepository(db);
  const taskService = new TaskService(taskRepo);

  const activityService = new ActivityService(
    db,
    projects,
    sessions,
    activities,
    decisions,
    taskService,
    config.maxResults,
  );
  const projectService = new ProjectService(
    db,
    projects,
    sessions,
    activities,
    decisions,
    taskService,
    config.databaseDisplayName,
    () => db.schemaVersion(),
  );
  const contextService = new ContextService(projects, activities, decisions, taskService);
  const searchService = new SearchService(db, projects, config.maxResults);
  const importService = new ImportService(db, projects, sessions, activities, {
    maxImportBytes: config.maxImportBytes,
    maxImportRecords: config.maxImportRecords,
    importAllowedDirs: config.importAllowedDirs,
  });

  return {
    db,
    config,
    activityService,
    projectService,
    contextService,
    searchService,
    importService,
  };
}

export async function buildContainer(config: AppConfig): Promise<Container> {
  const db = await MemoryDatabase.open(config.databaseUrl, migrations, { ssl: config.databaseSsl });
  return buildContainerFromDb(db, config);
}
