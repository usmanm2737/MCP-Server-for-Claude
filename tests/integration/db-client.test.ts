import { beforeEach, describe, expect, it } from 'vitest';

import { MemoryDatabase } from '../../src/db/client.js';
import { migrations } from '../../src/db/migrations/index.js';
import { getTestDb, resetTestDatabase } from '../helpers.js';

async function countProjects(db: MemoryDatabase): Promise<number> {
  const row = await db.queryOne<{ n: number }>('SELECT COUNT(*)::int AS n FROM projects');
  return row?.n ?? 0;
}

async function insertDummyProject(db: MemoryDatabase, id: string): Promise<void> {
  const ts = new Date().toISOString();
  await db.query(
    `INSERT INTO projects (id, name, slug, description, current_state, next_steps, created_at, updated_at)
     VALUES ($1, $2, $3, NULL, NULL, NULL, $4, $5)`,
    [id, `project-${id}`, `slug-${id}`, ts, ts],
  );
}

beforeEach(async () => {
  await resetTestDatabase();
});

describe('MemoryDatabase: schema initialization and migrations', () => {
  it('applies all migrations and records the schema version', async () => {
    const db = await getTestDb();
    const version = await db.schemaVersion();
    expect(version).toBe(migrations[migrations.length - 1]?.version);

    const tables = await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    const names = tables.map((t) => t.table_name);
    for (const expected of ['projects', 'sessions', 'activities', 'decisions', 'tasks', 'tags']) {
      expect(names).toContain(expected);
    }
  });

  it('is idempotent: opening an already-migrated database again applies nothing new', async () => {
    const db = await getTestDb();
    const versionBefore = await db.schemaVersion();
    // Opening a second pool against the same already-migrated database must not
    // re-run or fail on migration 1 (CREATE TABLE would otherwise collide).
    const second = await MemoryDatabase.open(process.env.TEST_DATABASE_URL ?? '', migrations, {
      ssl: 'require',
    });
    try {
      expect(await second.schemaVersion()).toBe(versionBefore);
    } finally {
      await second.close();
    }
  });
});

describe('MemoryDatabase: persistence across restarts', () => {
  it('data written by one connection pool is visible to a brand new one', async () => {
    const first = await getTestDb();
    await insertDummyProject(first, 'restart-check-1');
    expect(await countProjects(first)).toBe(1);

    const second = await MemoryDatabase.open(process.env.TEST_DATABASE_URL ?? '', migrations, {
      ssl: 'require',
    });
    try {
      expect(await countProjects(second)).toBe(1);
    } finally {
      await second.close();
    }
  });
});

describe('MemoryDatabase: transactions', () => {
  it('commits all writes when the callback succeeds', async () => {
    const db = await getTestDb();
    await db.transaction(async () => {
      await insertDummyProject(db, 'a');
      await insertDummyProject(db, 'b');
    });
    expect(await countProjects(db)).toBe(2);
  });

  it('rolls back all writes when the callback throws', async () => {
    const db = await getTestDb();
    await expect(
      db.transaction(async () => {
        await insertDummyProject(db, 'a');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await countProjects(db)).toBe(0);
  });

  it('a nested transaction() call uses a SAVEPOINT: a failure inside it rolls back the outer writes too', async () => {
    const db = await getTestDb();
    await expect(
      db.transaction(async () => {
        await insertDummyProject(db, 'outer');
        await db.transaction(async () => {
          await insertDummyProject(db, 'inner');
          throw new Error('inner boom');
        });
      }),
    ).rejects.toThrow('inner boom');
    expect(await countProjects(db)).toBe(0);
  });

  it('a successful nested transaction() call commits together with the outer one', async () => {
    const db = await getTestDb();
    await db.transaction(async () => {
      await insertDummyProject(db, 'outer');
      await db.transaction(async () => {
        await insertDummyProject(db, 'inner');
      });
    });
    expect(await countProjects(db)).toBe(2);
  });

  it('a nested transaction can roll back just its own SAVEPOINT without aborting the outer one', async () => {
    const db = await getTestDb();
    await db.transaction(async () => {
      await insertDummyProject(db, 'kept');
      await db
        .transaction(async () => {
          await insertDummyProject(db, 'discarded');
          throw new Error('rolled back locally');
        })
        .catch(() => {
          // swallow here — this test is about the OUTER transaction still
          // committing its own 'kept' row despite the inner one failing.
        });
    });
    const rows = await db.query<{ id: string }>('SELECT id FROM projects ORDER BY id');
    expect(rows.map((r) => r.id)).toEqual(['kept']);
  });

  it('concurrent transactions on separate async call stacks do not interfere with each other', async () => {
    const db = await getTestDb();
    // This is the scenario the AsyncLocalStorage-based transaction context exists
    // for: two "requests" in flight at once, each with its own transaction, must
    // not see or corrupt each other's state the way a single shared mutable
    // "current transaction" field would under real concurrency.
    const [resultA, resultB] = await Promise.all([
      db.transaction(async () => {
        await insertDummyProject(db, 'concurrent-a');
        return countProjects(db);
      }),
      db.transaction(async () => {
        await insertDummyProject(db, 'concurrent-b');
        return countProjects(db);
      }),
    ]);
    // Each transaction sees at least its own insert; both commit successfully.
    expect(resultA).toBeGreaterThanOrEqual(1);
    expect(resultB).toBeGreaterThanOrEqual(1);
    expect(await countProjects(db)).toBe(2);
  });
});
