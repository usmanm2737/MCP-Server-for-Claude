import type { AppConfig } from '../src/config/env.js';
import { MemoryDatabase } from '../src/db/client.js';
import { migrations } from '../src/db/migrations/index.js';
import { buildContainerFromDb, type Container } from '../src/container.js';

export type TestConfigOverrides = Partial<Omit<AppConfig, 'http' | 'remoteMcp'>> & {
  http?: Partial<AppConfig['http']>;
  remoteMcp?: Partial<AppConfig['remoteMcp']>;
};

function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. The test suite needs a real reachable Postgres database ' +
        '(a dedicated Supabase project or database works well, since every test table gets ' +
        'truncated between tests) — set it before running tests, e.g. in .env.',
    );
  }
  return url;
}

export function makeTestConfig(overrides: TestConfigOverrides = {}): AppConfig {
  const { http: httpOverrides, remoteMcp: remoteMcpOverrides, ...rest } = overrides;
  return {
    databaseUrl: testDatabaseUrl(),
    databaseSsl: 'require',
    databaseDisplayName: '(test database)',
    maxResults: 50,
    maxImportBytes: 5_000_000,
    maxImportRecords: 2000,
    importAllowedDirs: [],
    http: {
      enabled: false,
      host: '127.0.0.1',
      port: 8787,
      token: 'test-token',
      corsOrigins: [],
      ...httpOverrides,
    },
    remoteMcp: {
      enabled: false,
      host: '127.0.0.1',
      port: 8789,
      token: 'test-remote-mcp-token',
      allowedHosts: [],
      allowedOrigins: [],
      ...remoteMcpOverrides,
    },
    ...rest,
  };
}

// One real connection pool, shared by the whole test run (opening a fresh pool per
// test against a remote database would be slow and wasteful) — migrations run once,
// on first use.
let sharedDbPromise: Promise<MemoryDatabase> | null = null;

async function getSharedDb(): Promise<MemoryDatabase> {
  sharedDbPromise ??= MemoryDatabase.open(testDatabaseUrl(), migrations, { ssl: 'require' });
  return sharedDbPromise;
}

/** The same shared `MemoryDatabase` `makeTestContainer` uses — for tests that exercise the client/transaction API directly rather than through a container. */
export async function getTestDb(): Promise<MemoryDatabase> {
  return getSharedDb();
}

const APP_TABLES = [
  'activity_tags',
  'project_tags',
  'tags',
  'decisions',
  'tasks',
  'activities',
  'sessions',
  'projects',
];

/** Wipes every application table (not `schema_migrations`) so each test starts from empty. */
export async function resetTestDatabase(): Promise<void> {
  const db = await getSharedDb();
  await db.query(`TRUNCATE TABLE ${APP_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}

/** A real Postgres-backed container, reset to empty tables, isolated per test by `resetTestDatabase`. */
export async function makeTestContainer(overrides: TestConfigOverrides = {}): Promise<Container> {
  const db = await getSharedDb();
  await resetTestDatabase();
  return buildContainerFromDb(db, makeTestConfig(overrides));
}

/** Closes the shared pool — call once after the whole suite finishes (e.g. a `globalTeardown`). */
export async function closeSharedTestDb(): Promise<void> {
  if (sharedDbPromise) {
    const db = await sharedDbPromise;
    await db.close();
    sharedDbPromise = null;
  }
}
