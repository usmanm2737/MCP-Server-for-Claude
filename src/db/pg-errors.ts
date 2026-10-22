/** Postgres SQLSTATE codes this codebase checks for. https://www.postgresql.org/docs/current/errcodes-appendix.html */
const UNIQUE_VIOLATION = '23505';

interface PgErrorLike {
  code?: string;
  constraint?: string;
}

function asPgError(err: unknown): PgErrorLike | null {
  if (err && typeof err === 'object' && 'code' in err) return err as PgErrorLike;
  return null;
}

/** True if `err` is a Postgres unique-constraint violation, optionally for a specific named constraint. */
export function isUniqueViolation(err: unknown, constraintName?: string): boolean {
  const pgErr = asPgError(err);
  if (!pgErr || pgErr.code !== UNIQUE_VIOLATION) return false;
  return constraintName === undefined || pgErr.constraint === constraintName;
}
