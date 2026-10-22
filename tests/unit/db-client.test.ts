import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MemoryDatabase } from '../../src/db/client.js';
import { migrations } from '../../src/db/migrations/index.js';

function countProjects(db: MemoryDatabase): number {
  const row = db.raw.prepare('SELECT COUNT(*) AS n FROM projects').get() as unknown as {
    n: number;
  };
  return row.n;
}

function insertDummyProject(db: MemoryDatabase, id: string): void {
  const ts = new Date().toISOString();
  db.raw
    .prepare(
      `INSERT INTO projects (id, name, slug, description, current_state, next_steps, created_at, updated_at)
       VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?)`,
    )
    .run(id, `project-${id}`, `slug-${id}`, ts, ts);
}

describe('MemoryDatabase: schema initialization and migrations', () => {
  it('applies all migrations on a fresh in-memory database and records the schema version', () => {
    const db = MemoryDatabase.openInMemory(migrations);
    expect(db.schemaVersion()).toBe(migrations[migrations.length - 1]?.version);
    const tables = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as unknown as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    for (const expected of ['projects', 'sessions', 'activities', 'decisions', 'tasks', 'tags']) {
      expect(names).toContain(expected);
    }
    db.close();
  });

  it('is idempotent: opening an already-migrated database again applies nothing new', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cam-test-'));
    const dbPath = join(dir, 'memory.db');
    try {
      const first = MemoryDatabase.open(dbPath, migrations);
      const versionAfterFirst = first.schemaVersion();
      first.close();

      const second = MemoryDatabase.open(dbPath, migrations);
      expect(second.schemaVersion()).toBe(versionAfterFirst);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('MemoryDatabase: persistence across restarts', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cam-test-'));
    dbPath = join(dir, 'memory.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('data written before close is visible after reopening the same file', () => {
    const db1 = MemoryDatabase.open(dbPath, migrations);
    insertDummyProject(db1, 'p1');
    expect(countProjects(db1)).toBe(1);
    db1.close();

    const db2 = MemoryDatabase.open(dbPath, migrations);
    expect(countProjects(db2)).toBe(1);
    db2.close();
  });
});

describe('MemoryDatabase: transactions', () => {
  it('commits all writes when the callback succeeds', () => {
    const db = MemoryDatabase.openInMemory(migrations);
    db.transaction(() => {
      insertDummyProject(db, 'a');
      insertDummyProject(db, 'b');
    });
    expect(countProjects(db)).toBe(2);
    db.close();
  });

  it('rolls back all writes when the callback throws', () => {
    const db = MemoryDatabase.openInMemory(migrations);
    expect(() =>
      db.transaction(() => {
        insertDummyProject(db, 'a');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(countProjects(db)).toBe(0);
    db.close();
  });

  it('a nested transaction() call joins the outer one: a failure inside it rolls back the outer writes too', () => {
    const db = MemoryDatabase.openInMemory(migrations);
    expect(() =>
      db.transaction(() => {
        insertDummyProject(db, 'outer');
        db.transaction(() => {
          insertDummyProject(db, 'inner');
          throw new Error('inner boom');
        });
      }),
    ).toThrow('inner boom');
    // Neither the outer nor the inner write should have survived.
    expect(countProjects(db)).toBe(0);
    db.close();
  });

  it('a successful nested transaction() call commits together with the outer one', () => {
    const db = MemoryDatabase.openInMemory(migrations);
    db.transaction(() => {
      insertDummyProject(db, 'outer');
      db.transaction(() => {
        insertDummyProject(db, 'inner');
      });
    });
    expect(countProjects(db)).toBe(2);
    db.close();
  });
});
