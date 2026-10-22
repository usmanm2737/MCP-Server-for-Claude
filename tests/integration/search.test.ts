import { describe, expect, it } from 'vitest';

import { makeTestContainer } from '../helpers.js';
import type { Container } from '../../src/container.js';

async function seed(container: Container): Promise<void> {
  await container.activityService.saveActivity({
    projectName: 'Alpha',
    activityType: 'decision',
    title: 'Chose PostgreSQL',
    summary: 'Picked PostgreSQL for the main datastore because of JSONB support.',
  });
  await container.activityService.saveActivity({
    projectName: 'Alpha',
    activityType: 'note',
    title: 'Deploy notes',
    summary: 'Deployed the staging environment on Fridge infrastructure.',
  });
  await container.activityService.saveActivity({
    projectName: 'Beta',
    activityType: 'note',
    title: 'Unrelated project note',
    summary: 'PostgreSQL also used here, different project though.',
  });
}

describe('SearchService.search', () => {
  it('finds matches by keyword across title/summary', async () => {
    const container = await makeTestContainer();
    await seed(container);
    const { hits } = await container.searchService.search({ query: 'PostgreSQL' });
    expect(hits.length).toBe(2);
  });

  it('filters by projectName', async () => {
    const container = await makeTestContainer();
    await seed(container);
    const { hits } = await container.searchService.search({
      query: 'PostgreSQL',
      projectName: 'Alpha',
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.projectName).toBe('Alpha');
  });

  it('filters by activityType', async () => {
    const container = await makeTestContainer();
    await seed(container);
    const { hits } = await container.searchService.search({
      query: 'PostgreSQL',
      activityType: 'decision',
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.activityType).toBe('decision');
  });

  it('returns an empty list with a note for an unknown project filter, rather than throwing', async () => {
    const container = await makeTestContainer();
    await seed(container);
    const { hits, note } = await container.searchService.search({
      query: 'PostgreSQL',
      projectName: 'Ghost',
    });
    expect(hits).toHaveLength(0);
    expect(note).toMatch(/no project/i);
  });

  it('returns an empty list with a note for an empty query, rather than throwing', async () => {
    const container = await makeTestContainer();
    await seed(container);
    const { hits, note } = await container.searchService.search({ query: '   ' });
    expect(hits).toHaveLength(0);
    expect(note).toBeTruthy();
  });

  it('returns an empty list (not an error) for a query that matches nothing', async () => {
    const container = await makeTestContainer();
    await seed(container);
    const { hits } = await container.searchService.search({ query: 'nonexistentxyz' });
    expect(hits).toHaveLength(0);
  });

  it('bounds results to the configured maxResults even if a larger limit is requested', async () => {
    const container = await makeTestContainer({ maxResults: 2 });
    for (let i = 0; i < 5; i++) {
      await container.activityService.saveActivity({
        projectName: 'Alpha',
        activityType: 'note',
        title: `Widget ${i}`,
        summary: 'widget content',
      });
    }
    const { hits } = await container.searchService.search({ query: 'widget', limit: 100 });
    expect(hits.length).toBeLessThanOrEqual(2);
  });

  it('date range filters (startDate/endDate) narrow results', async () => {
    const container = await makeTestContainer();
    await seed(container);
    const farFuture = '2999-01-01T00:00:00.000Z';
    const { hits } = await container.searchService.search({
      query: 'PostgreSQL',
      startDate: farFuture,
    });
    expect(hits).toHaveLength(0);
  });

  it('matches punctuation-heavy text (e.g. a timestamp) the same way it was indexed', async () => {
    // Regression test for the SQLite/FTS5-era bug this project's search query
    // builder once had (fixed before the Postgres move, but the underlying
    // risk — punctuation inside a search term — is worth covering here too,
    // against Postgres's own tokenizer this time).
    const container = await makeTestContainer();
    const marker = 'build v2.3.1-rc1 completed at 2026-10-22T11:41:56.636Z';
    await container.activityService.saveActivity({
      projectName: 'Alpha',
      activityType: 'note',
      title: marker,
      summary: marker,
    });
    const { hits } = await container.searchService.search({ query: marker });
    expect(hits).toHaveLength(1);
  });
});
