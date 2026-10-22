import { DatabaseSync } from 'node:sqlite';

import { logger } from '../utils/logging.js';
import { nowIso } from '../utils/ids.js';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: readonly string[];
}

/**
 * Thin wrapper around `node:sqlite`'s `DatabaseSync`: applies pending
 * migrations on open and provides a transaction helper. `node:sqlite` has no
 * built-in `.transaction()` convenience (unlike `better-sqlite3`), so
 * `transaction()` below hand-rolls BEGIN IMMEDIATE/COMMIT/ROLLBACK.
 *
 * We use Node's built-in `node:sqlite` (stable, flag-free on Node >=22.13 /
 * 23.4+) instead of the `better-sqlite3` native module: one fewer
 * native-binding dependency to prebuild/install, and it has full FTS5
 * support, which is all this project needs.
 */
export class MemoryDatabase {
  private readonly db: DatabaseSync;
  private txDepth = 0;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  static open(dbPath: string, migrations: readonly Migration[]): MemoryDatabase {
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');

    const instance = new MemoryDatabase(db);
    instance.runMigrations(migrations);
    return instance;
  }

  /** For tests: an in-memory database that still runs migrations. */
  static openInMemory(migrations: readonly Migration[]): MemoryDatabase {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    const instance = new MemoryDatabase(db);
    instance.runMigrations(migrations);
    return instance;
  }

  private runMigrations(migrations: readonly Migration[]): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);

    const appliedRow = this.db
      .prepare('SELECT MAX(version) AS v FROM schema_migrations')
      .get() as unknown as { v: number | null } | undefined;
    const currentVersion = appliedRow?.v ?? 0;

    const pending = [...migrations]
      .sort((a, b) => a.version - b.version)
      .filter((m) => m.version > currentVersion);

    for (const migration of pending) {
      this.transaction(() => {
        for (const statement of migration.up) {
          this.db.exec(statement);
        }
        this.db
          .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(migration.version, migration.name, nowIso());
      });
      logger.info('migration applied', { version: migration.version, name: migration.name });
    }
  }

  schemaVersion(): number {
    const row = this.db
      .prepare('SELECT MAX(version) AS v FROM schema_migrations')
      .get() as unknown as { v: number | null } | undefined;
    return row?.v ?? 0;
  }

  get raw(): DatabaseSync {
    return this.db;
  }

  /**
   * Runs `fn` inside a BEGIN IMMEDIATE/COMMIT transaction, rolling back on
   * any thrown error. SQLite has no nested transactions, so a call made
   * while already inside one (tracked via `txDepth`) just runs `fn()`
   * inline and joins the outer transaction's commit/rollback — this lets a
   * repository method wrap its own multi-statement write atomically while
   * still composing cleanly inside a larger service-level transaction.
   */
  transaction<T>(fn: () => T): T {
    if (this.txDepth > 0) {
      return fn();
    }
    this.txDepth++;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch (rollbackErr) {
        logger.error('rollback failed', { error: String(rollbackErr) });
      }
      throw err;
    } finally {
      this.txDepth--;
    }
  }

  close(): void {
    this.db.close();
  }
}
