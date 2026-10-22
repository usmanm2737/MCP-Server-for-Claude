/**
 * Typed application errors. Messages on these are always safe to show to an
 * MCP client or HTTP caller — never attach raw driver errors, stack traces,
 * or file paths to `message`.
 */
export class AppError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class NotFoundError extends AppError {
  constructor(entity: string, id: string) {
    super('NOT_FOUND', `${entity} not found: ${id}`);
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super('VALIDATION_ERROR', message);
  }
}

export class DuplicateError extends AppError {
  constructor(message: string) {
    super('DUPLICATE', message);
  }
}

export class ImportRejectedError extends AppError {
  constructor(message: string) {
    super('IMPORT_REJECTED', message);
  }
}

export class ConfigError extends AppError {
  constructor(message: string) {
    super('CONFIG_ERROR', message);
  }
}

/** True for errors we deliberately raised and whose `message` is safe to surface verbatim. */
export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/**
 * Produces a message safe to send to a client for any thrown value.
 * Known AppErrors pass their message through; anything else is collapsed to
 * a generic message so internal details (stack traces, native driver text,
 * file paths) never leak across the MCP/HTTP boundary.
 */
export function toSafeErrorMessage(err: unknown): string {
  if (isAppError(err)) return err.message;
  return 'An unexpected internal error occurred.';
}

export function toSafeErrorCode(err: unknown): string {
  if (isAppError(err)) return err.code;
  return 'INTERNAL_ERROR';
}
