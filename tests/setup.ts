import { afterAll } from 'vitest';

import { closeSharedTestDb } from './helpers.js';

// Runs once per isolated test-file context (vitest's default `isolate: true`
// gives each file its own module registry, so each file's own `helpers.ts`
// singleton pool gets closed here rather than leaking past that file's run).
afterAll(async () => {
  await closeSharedTestDb();
});
