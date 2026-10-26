import type { AppConfig } from './config/env.js';
import { MemoryDatabase } from './db/client.js';
import { migrations } from './db/migrations/index.js';
import { ProjectRepository } from './db/repositories/project-repository.js';
import { SessionRepository } from './db/repositories/session-repository.js';
import { ActivityRepository } from './db/repositories/activity-repository.js';
import { DecisionRepository } from './db/repositories/decision-repository.js';
import { TaskRepository } from './db/repositories/task-repository.js';
import { CustomPromptRepository } from './db/repositories/custom-prompt-repository.js';
import { CustomResourceRepository } from './db/repositories/custom-resource-repository.js';
import { ActivityService } from './services/activity-service.js';
import { ProjectService } from './services/project-service.js';
import { ContextService } from './services/context-service.js';
import { SearchService } from './services/search-service.js';
import { ImportService } from './services/import-service.js';
import { TaskService } from './services/task-service.js';
import { CustomContentService } from './services/custom-content-service.js';

/**
 * Composition root: wires repositories and services over one open database.
 * Built once by the stdio/HTTP entrypoints; tests build their own over an
 * in-memory database via `buildContainerFromDb`.
 */
export interface Container {
  db: MemoryDatabase;
  config: AppConfig;
  activityService: ActivityService;
  projectService: ProjectService;
  contextService: ContextService;
  searchService: SearchService;
  importService: ImportService;
  customContentService: CustomContentService;
}

export function buildContainerFromDb(db: MemoryDatabase, config: AppConfig): Container {
  const projects = new ProjectRepository(db);
  const sessions = new SessionRepository(db);
  const activities = new ActivityRepository(db);
  const decisions = new DecisionRepository(db);
  const taskRepo = new TaskRepository(db);
  const taskService = new TaskService(taskRepo);
  const customPrompts = new CustomPromptRepository(db);
  const customResources = new CustomResourceRepository(db);
  const customContentService = new CustomContentService(customPrompts, customResources);

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
    config.dbPath,
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
    customContentService,
  };
}

export function buildContainer(config: AppConfig): Container {
  const db = MemoryDatabase.open(config.dbPath, migrations);
  return buildContainerFromDb(db, config);
}

export function buildInMemoryContainer(config: AppConfig): Container {
  const db = MemoryDatabase.openInMemory(migrations);
  return buildContainerFromDb(db, config);
}
