import { describe, expect, it } from 'vitest';

import { makeTestContainer } from '../helpers.js';

function seed(container: ReturnType<typeof makeTestContainer>): void {
  container.activityService.saveActivity({
    projectName: 'Alpha',
    activityType: 'decision',
    title: 'Chose PostgreSQL',
    summary: 'Picked PostgreSQL for the main datastore because of JSONB support.',
  });
  container.activityService.saveActivity({
    projectName: 'Alpha',
    activityType: 'note',
    title: 'Deploy notes',
    summary: 'Deployed the staging environment on Fridge infrastructure.',
  });
  container.activityService.saveActivity({
    projectName: 'Beta',
    activityType: 'note',
    title: 'Unrelated project note',
    summary: 'PostgreSQL also used here, different project though.',
  });
}

describe('SearchService.search', () => {
  it('finds matches by keyword across title/summary', () => {
    const container = makeTestContainer();
    seed(container);
    const { hits } = container.searchService.search({ query: 'PostgreSQL' });
    expect(hits.length).toBe(2);
  });

  it('filters by projectName', () => {
    const container = makeTestContainer();
    seed(container);
    const { hits } = container.searchService.search({ query: 'PostgreSQL', projectName: 'Alpha' });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.projectName).toBe('Alpha');
  });

  it('filters by activityType', () => {
    const container = makeTestContainer();
    seed(container);
    const { hits } = container.searchService.search({
      query: 'PostgreSQL',
      activityType: 'decision',
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.activityType).toBe('decision');
  });

  it('returns an empty list with a note for an unknown project filter, rather than throwing', () => {
    const container = makeTestContainer();
    seed(container);
    const { hits, note } = container.searchService.search({
      query: 'PostgreSQL',
      projectName: 'Ghost',
    });
    expect(hits).toHaveLength(0);
    expect(note).toMatch(/no project/i);
  });

  it('returns an empty list with a note for an empty query, rather than throwing', () => {
    const container = makeTestContainer();
    seed(container);
    const { hits, note } = container.searchService.search({ query: '   ' });
    expect(hits).toHaveLength(0);
    expect(note).toBeTruthy();
  });

  it('returns an empty list (not an error) for a query that matches nothing', () => {
    const container = makeTestContainer();
    seed(container);
    const { hits } = container.searchService.search({ query: 'nonexistentxyz' });
    expect(hits).toHaveLength(0);
  });

  it('bounds results to the configured maxResults even if a larger limit is requested', () => {
    const container = makeTestContainer({ maxResults: 2 });
    for (let i = 0; i < 5; i++) {
      container.activityService.saveActivity({
        projectName: 'Alpha',
        activityType: 'note',
        title: `Widget ${i}`,
        summary: 'widget content',
      });
    }
    const { hits } = container.searchService.search({ query: 'widget', limit: 100 });
    expect(hits.length).toBeLessThanOrEqual(2);
  });

  it('date range filters (startDate/endDate) narrow results', () => {
    const container = makeTestContainer();
    seed(container);
    const farFuture = '2999-01-01T00:00:00.000Z';
    const { hits } = container.searchService.search({ query: 'PostgreSQL', startDate: farFuture });
    expect(hits).toHaveLength(0);
  });
});
