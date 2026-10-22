import { describe, expect, it } from 'vitest';

import { makeTestContainer } from '../helpers.js';
import { NotFoundError } from '../../src/utils/errors.js';

describe('ActivityService.saveActivity', () => {
  it('creates the project automatically and returns a fresh id/timestamp', () => {
    const container = makeTestContainer();
    const { activity, duplicate } = container.activityService.saveActivity({
      projectName: 'Alpha',
      activityType: 'milestone',
      title: 'Shipped v1',
      summary: 'First release went out.',
    });
    expect(duplicate).toBe(false);
    expect(activity.id).toBeTruthy();
    expect(Number.isNaN(Date.parse(activity.createdAt))).toBe(false);
  });

  it('treats an identical save as a duplicate and does not insert a second row', () => {
    const container = makeTestContainer();
    const input = {
      projectName: 'Alpha',
      activityType: 'milestone',
      title: 'Shipped v1',
      summary: 'First release went out.',
    } as const;
    const first = container.activityService.saveActivity(input);
    const second = container.activityService.saveActivity(input);
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.activity.id).toBe(first.activity.id);

    const stats = container.projectService.getMemoryStats();
    expect(stats.counts.activities).toBe(1);
  });

  it('activityType "decision" also creates a Decision row linked to the activity', () => {
    const container = makeTestContainer();
    const { activity } = container.activityService.saveActivity({
      projectName: 'Alpha',
      activityType: 'decision',
      title: 'Use Postgres',
      summary: 'Chose Postgres over MySQL for JSONB support.',
    });
    const stats = container.projectService.getMemoryStats();
    expect(stats.counts.decisions).toBe(1);

    const context = container.contextService.getProjectContext({ projectName: 'Alpha' });
    expect(context.decisions).toHaveLength(1);
    expect(context.decisions[0]?.activityId).toBe(activity.id);
    expect(context.decisions[0]?.decision).toBe('Use Postgres');
  });

  it('activityType "blocker" creates a Task with status "blocked"', () => {
    const container = makeTestContainer();
    container.activityService.saveActivity({
      projectName: 'Alpha',
      activityType: 'blocker',
      title: 'Waiting on API keys',
      summary: 'Cannot proceed without vendor credentials.',
    });
    const context = container.contextService.getProjectContext({ projectName: 'Alpha' });
    expect(context.blockedTasks).toHaveLength(1);
    expect(context.openTasks).toHaveLength(0);
  });

  it('activityType "task" creates an open Task', () => {
    const container = makeTestContainer();
    container.activityService.saveActivity({
      projectName: 'Alpha',
      activityType: 'task',
      title: 'Write docs',
      summary: 'Document the new endpoint.',
    });
    const context = container.contextService.getProjectContext({ projectName: 'Alpha' });
    expect(context.openTasks).toHaveLength(1);
    expect(context.blockedTasks).toHaveLength(0);
  });
});

describe('ActivityService.deleteActivity', () => {
  it('removes the activity and its FTS entry, but throws NotFoundError for an unknown id', () => {
    const container = makeTestContainer();
    const { activity } = container.activityService.saveActivity({
      projectName: 'Alpha',
      activityType: 'note',
      title: 'Searchable note',
      summary: 'unicorn-marker-xyz appears only here',
    });

    const before = container.searchService.search({ query: 'unicorn-marker-xyz' });
    expect(before.hits).toHaveLength(1);

    container.activityService.deleteActivity({ activityId: activity.id, confirm: true });

    const after = container.searchService.search({ query: 'unicorn-marker-xyz' });
    expect(after.hits).toHaveLength(0);

    expect(() =>
      container.activityService.deleteActivity({ activityId: activity.id, confirm: true }),
    ).toThrow(NotFoundError);
  });

  it('detaches, but does not delete, decisions/tasks that referenced the deleted activity', () => {
    const container = makeTestContainer();
    const { activity } = container.activityService.saveActivity({
      projectName: 'Alpha',
      activityType: 'decision',
      title: 'Use SQLite',
      summary: 'Simplest option for a local-first tool.',
    });

    container.activityService.deleteActivity({ activityId: activity.id, confirm: true });

    const stats = container.projectService.getMemoryStats();
    expect(stats.counts.decisions).toBe(1); // decision itself survives
    expect(stats.counts.activities).toBe(0); // activity is gone
  });
});

describe('ContextService.getProjectContext', () => {
  it('throws NotFoundError for an unknown project rather than creating one', () => {
    const container = makeTestContainer();
    expect(() => container.contextService.getProjectContext({ projectName: 'Ghost' })).toThrow(
      NotFoundError,
    );
    expect(container.projectService.getMemoryStats().counts.projects).toBe(0);
  });

  it('never includes the full activity content, only summaries', () => {
    const container = makeTestContainer();
    container.activityService.saveActivity({
      projectName: 'Alpha',
      activityType: 'note',
      title: 'Big note',
      summary: 'short summary',
      content: 'a'.repeat(50_000),
    });
    const context = container.contextService.getProjectContext({ projectName: 'Alpha' });
    expect(context.recentActivities[0]?.content).toBeNull();
  });
});

describe('ProjectService.updateProjectState', () => {
  it('creates the project if needed, persists state, and preserves the description on later updates', () => {
    const container = makeTestContainer();
    container.projectService.updateProjectState({
      projectName: 'Beta',
      currentState: 'In progress',
      nextSteps: 'Write tests',
    });

    const stats1 = container.projectService.getMemoryStats();
    expect(stats1.counts.projects).toBe(1);
    expect(stats1.counts.activities).toBe(1); // the state-update activity

    const updated = container.projectService.updateProjectState({
      projectName: 'Beta',
      currentState: 'Almost done',
      nextSteps: 'Ship it',
      notes: 'Switched approach after review.',
    });
    expect(updated.currentState).toBe('Almost done');
    expect(updated.nextSteps).toBe('Ship it');

    const context = container.contextService.getProjectContext({ projectName: 'Beta' });
    expect(context.project.currentState).toBe('Almost done');
  });

  it('does not duplicate the state-update activity for an identical repeat call', () => {
    const container = makeTestContainer();
    const input = {
      projectName: 'Beta',
      currentState: 'In progress',
      nextSteps: 'Write tests',
    } as const;
    container.projectService.updateProjectState(input);
    container.projectService.updateProjectState(input);
    const stats = container.projectService.getMemoryStats();
    expect(stats.counts.activities).toBe(1);
  });
});

describe('ActivityService.getRecentActivity', () => {
  it('returns an empty list with a note for an unknown project, rather than throwing', () => {
    const container = makeTestContainer();
    const { activities, note } = container.activityService.getRecentActivity({
      projectName: 'Ghost',
    });
    expect(activities).toHaveLength(0);
    expect(note).toMatch(/no project/i);
  });

  it('orders newest first and respects the limit', () => {
    const container = makeTestContainer();
    for (let i = 0; i < 5; i++) {
      container.activityService.saveActivity({
        projectName: 'Alpha',
        activityType: 'note',
        title: `Note ${i}`,
        summary: `Summary ${i}`,
      });
    }
    const { activities } = container.activityService.getRecentActivity({
      projectName: 'Alpha',
      limit: 3,
    });
    expect(activities).toHaveLength(3);
    expect(activities[0]?.title).toBe('Note 4');
  });
});
