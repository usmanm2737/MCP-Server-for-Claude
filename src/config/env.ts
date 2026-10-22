import { ConfigError } from '../utils/errors.js';
import type { SslMode } from '../db/client.js';

function readInt(name: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`${name} must be a positive integer, got: ${raw}`);
  }
  return value;
}

function readBool(name: string, fallback: boolean, env: NodeJS.ProcessEnv): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw.toLowerCase() === 'true' || raw === '1';
}

const VALID_SSL_MODES: readonly SslMode[] = ['disable', 'require', 'strict'];

function readSslMode(env: NodeJS.ProcessEnv): SslMode {
  const raw = env.CLAUDE_MEMORY_DB_SSL?.trim().toLowerCase();
  if (!raw) return 'require';
  if (!VALID_SSL_MODES.includes(raw as SslMode)) {
    throw new ConfigError(
      `CLAUDE_MEMORY_DB_SSL must be one of ${VALID_SSL_MODES.join(', ')}, got: ${raw}`,
    );
  }
  return raw as SslMode;
}

/**
 * The connection string without its credentials — safe to put in logs or a
 * `get_memory_stats` tool response. A raw Postgres URI carries a password
 * (`postgres://user:password@host:port/db`); that must never leave this
 * process once parsed.
 */
export function redactConnectionString(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    const database = url.pathname.replace(/^\//, '') || '(default)';
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}/${database}`;
  } catch {
    return '(unparseable connection string)';
  }
}

export interface AppConfig {
  readonly databaseUrl: string;
  readonly databaseSsl: SslMode;
  /** Host/database only, credentials stripped — see `redactConnectionString`. */
  readonly databaseDisplayName: string;
  readonly maxResults: number;
  readonly maxImportBytes: number;
  readonly maxImportRecords: number;
  /** If non-empty, `import_conversation`'s `filePath` must resolve inside one of these directories. Empty = unrestricted (the MCP caller's explicit choice of path is itself the "user-selected file"). */
  readonly importAllowedDirs: readonly string[];
  readonly http: {
    readonly enabled: boolean;
    readonly host: string;
    readonly port: number;
    readonly token: string | undefined;
    readonly corsOrigins: readonly string[];
  };
  /** The remote/web-client MCP server (Streamable HTTP) — a separate, also-optional entrypoint from the REST `http` block above. For claude.ai or another remote MCP client, over a tunnel (ngrok) while testing or a real deployment (e.g. Render) in production. */
  readonly remoteMcp: {
    readonly enabled: boolean;
    readonly host: string;
    readonly port: number;
    readonly token: string | undefined;
    /** Hostnames (no port) a request's Host header is allowed to present — must include your tunnel's or deployment's public hostname, or every request is rejected as a possible DNS-rebinding attack. */
    readonly allowedHosts: readonly string[];
    /** Hostnames (no port) a request's Origin header is allowed to present, when present at all. */
    readonly allowedOrigins: readonly string[];
  };
}

/** Reads and validates configuration from the environment. Throws `ConfigError` for anything invalid or missing that's required. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL?.trim() || env.CLAUDE_MEMORY_DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new ConfigError(
      'DATABASE_URL (a Postgres connection string, e.g. from Supabase) is not set. ' +
        'This server has no local-file fallback — see README "Database: Supabase/Postgres setup".',
    );
  }

  const httpEnabled = readBool('CLAUDE_MEMORY_HTTP_ENABLED', false, env);
  const token = env.CLAUDE_MEMORY_HTTP_TOKEN?.trim();

  if (httpEnabled && !token) {
    throw new ConfigError(
      'CLAUDE_MEMORY_HTTP_ENABLED is true but CLAUDE_MEMORY_HTTP_TOKEN is not set. ' +
        'Refusing to start the HTTP API without an auth token, even for localhost-only use.',
    );
  }

  const corsOrigins = (env.CLAUDE_MEMORY_HTTP_CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (corsOrigins.includes('*')) {
    throw new ConfigError(
      'CLAUDE_MEMORY_HTTP_CORS_ORIGINS must not contain "*" for an authenticated write API.',
    );
  }

  const remoteMcpEnabled = readBool('CLAUDE_MEMORY_REMOTE_MCP_ENABLED', false, env);
  const remoteMcpToken = env.CLAUDE_MEMORY_REMOTE_MCP_TOKEN?.trim();

  if (remoteMcpEnabled && !remoteMcpToken) {
    throw new ConfigError(
      'CLAUDE_MEMORY_REMOTE_MCP_ENABLED is true but CLAUDE_MEMORY_REMOTE_MCP_TOKEN is not set. ' +
        'Refusing to start the remote MCP server without an auth token — it is meant to be reachable ' +
        'from the public internet (a tunnel or a real deployment), unlike the stdio server.',
    );
  }

  const splitList = (raw: string | undefined): string[] =>
    (raw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

  // Render (and most PaaS platforms) inject `PORT` and expect the app to bind
  // 0.0.0.0; `RENDER` itself is set automatically on Render's own runtime.
  // Both are sensible defaults to detect rather than require every deployer
  // to set CLAUDE_MEMORY_REMOTE_MCP_HOST/PORT by hand.
  const onRenderLikePlatform = Boolean(env.RENDER) || env.PORT !== undefined;

  return {
    databaseUrl,
    databaseSsl: readSslMode(env),
    databaseDisplayName: redactConnectionString(databaseUrl),
    maxResults: readInt('CLAUDE_MEMORY_MAX_RESULTS', 50, env),
    maxImportBytes: readInt('CLAUDE_MEMORY_MAX_IMPORT_BYTES', 5_000_000, env),
    maxImportRecords: readInt('CLAUDE_MEMORY_MAX_IMPORT_RECORDS', 2000, env),
    importAllowedDirs: splitList(env.CLAUDE_MEMORY_IMPORT_DIRS),
    http: {
      enabled: httpEnabled,
      host:
        env.CLAUDE_MEMORY_HTTP_HOST && env.CLAUDE_MEMORY_HTTP_HOST.trim() !== ''
          ? env.CLAUDE_MEMORY_HTTP_HOST
          : '127.0.0.1',
      port: readInt('CLAUDE_MEMORY_HTTP_PORT', 8787, env),
      token,
      corsOrigins,
    },
    remoteMcp: {
      enabled: remoteMcpEnabled,
      host:
        env.CLAUDE_MEMORY_REMOTE_MCP_HOST && env.CLAUDE_MEMORY_REMOTE_MCP_HOST.trim() !== ''
          ? env.CLAUDE_MEMORY_REMOTE_MCP_HOST
          : onRenderLikePlatform
            ? '0.0.0.0'
            : '127.0.0.1',
      port: readInt('PORT', readInt('CLAUDE_MEMORY_REMOTE_MCP_PORT', 8789, env), env),
      token: remoteMcpToken,
      allowedHosts: splitList(env.CLAUDE_MEMORY_REMOTE_MCP_ALLOWED_HOSTS),
      allowedOrigins: splitList(env.CLAUDE_MEMORY_REMOTE_MCP_ALLOWED_ORIGINS),
    },
  };
}
