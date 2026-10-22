import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient, type QueryResultRow } from 'pg';

import { logger } from '../utils/logging.js';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: readonly string[];
}

export type SslMode = 'disable' | 'require' | 'strict';

/**
 * Per-async-call-stack transaction context. Concurrent requests each get
 * their own entry here — unlike the single shared mutable counter that
 * worked for the old single-threaded-synchronous SQLite client, a Postgres
 * connection pool serves genuinely concurrent requests (multiple remote MCP
 * sessions at once), so "the current transaction" can never be a single
 * instance field. `AsyncLocalStorage` gives each call stack its own view.
 */
const transactionContext = new AsyncLocalStorage<PoolClient>();

/**
 * Thin wrapper around a `pg` connection pool: applies pending migrations on
 * open, and provides `query`/`transaction` helpers that are safe under real
 * concurrency (see `transactionContext` above). Nested `transaction()` calls
 * use a `SAVEPOINT`, so they get genuine nested-rollback semantics — unlike
 * the SQLite-era client, which could only join-or-start a single outer
 * transaction.
 */
export class MemoryDatabase {
  private readonly pool: Pool;

  private constructor(pool: Pool) {
    this.pool = pool;
  }

  static async open(
    connectionString: string,
    migrations: readonly Migration[],
    options: { ssl?: SslMode } = {},
  ): Promise<MemoryDatabase> {
    const pool = new Pool({
      connectionString,
      ssl: resolveSsl(options.ssl ?? 'require'),
    });
    const db = new MemoryDatabase(pool);
    await db.runMigrations(migrations);
    return db;
  }

  /** Runs a query, participating in the ambient transaction (if any) for this async call stack. */
  async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> {
    const client = transactionContext.getStore();
    const result = client
      ? await client.query<T>(sql, params as unknown[])
      : await this.pool.query<T>(sql, params as unknown[]);
    return result.rows;
  }

  async queryOne<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }

  /**
   * Runs `fn` inside a transaction. A call made while already inside one
   * (tracked via `transactionContext`, scoped to this call stack) uses a
   * `SAVEPOINT` instead of a fresh `BEGIN`, so a repository method's own
   * `transaction()` call composes correctly whether it's invoked standalone
   * or from within a larger service-level transaction.
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const existing = transactionContext.getStore();
    if (existing) {
      const savepoint = `sp_${randomUUID().replace(/-/g, '')}`;
      await existing.query(`SAVEPOINT ${savepoint}`);
      try {
        const result = await fn();
        await existing.query(`RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (err) {
        await existing.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        throw err;
      }
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await transactionContext.run(client, fn);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        logger.error('rollback failed', { error: String(rollbackErr) });
      }
      throw err;
    } finally {
      client.release();
    }
  }

  private async runMigrations(migrations: readonly Migration[]): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);

    const appliedRow = await this.queryOne<{ v: number | null }>(
      'SELECT MAX(version) AS v FROM schema_migrations',
    );
    const currentVersion = appliedRow?.v ?? 0;

    const pending = [...migrations]
      .sort((a, b) => a.version - b.version)
      .filter((m) => m.version > currentVersion);

    for (const migration of pending) {
      await this.transaction(async () => {
        for (const statement of migration.up) {
          await this.query(statement);
        }
        await this.query(
          'INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, $3)',
          [migration.version, migration.name, new Date().toISOString()],
        );
      });
      logger.info('migration applied', { version: migration.version, name: migration.name });
    }
  }

  async schemaVersion(): Promise<number> {
    const row = await this.queryOne<{ v: number | null }>(
      'SELECT MAX(version) AS v FROM schema_migrations',
    );
    return row?.v ?? 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function resolveSsl(mode: SslMode): boolean | { rejectUnauthorized: boolean } {
  switch (mode) {
    case 'disable':
      return false;
    case 'strict':
      return { rejectUnauthorized: true };
    case 'require':
    default:
      // Supabase (and most managed Postgres) terminate TLS with a certificate
      // chain that Node's default CA bundle may not have — this still
      // encrypts the connection, it just doesn't verify the server's cert
      // chain. Use 'strict' (a real CA bundle) if that matters for your setup.
      return { rejectUnauthorized: false };
  }
}
