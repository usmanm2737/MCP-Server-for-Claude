import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { ConfigError } from '../utils/errors.js';

function defaultDataDir(): string {
  const appName = 'claude-activity-memory';
  if (process.platform === 'win32') {
    const base = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    return join(base, appName);
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', appName);
  }
  const base = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  return join(base, appName);
}

function defaultDbPath(): string {
  return join(defaultDataDir(), 'memory.db');
}

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`${name} must be a positive integer, got: ${raw}`);
  }
  return value;
}

function readBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw.toLowerCase() === 'true' || raw === '1';
}

export interface AppConfig {
  readonly dbPath: string;
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
  /** The remote/web-client MCP server (Streamable HTTP) — a separate, also-optional entrypoint from the REST `http` block above. For exposing this server to claude.ai or another remote MCP client, typically via a tunnel (e.g. ngrok) during testing. */
  readonly remoteMcp: {
    readonly enabled: boolean;
    readonly host: string;
    readonly port: number;
    readonly token: string | undefined;
    /** Hostnames (no port) a request's Host header is allowed to present — must include your tunnel's hostname (e.g. the ngrok one) or every request will be rejected as a possible DNS-rebinding attack. */
    readonly allowedHosts: readonly string[];
    /** Hostnames (no port) a request's Origin header is allowed to present, when present at all. */
    readonly allowedOrigins: readonly string[];
    /**
     * DANGEROUS, deliberately off by default and never set in `.env`: when true, every `/mcp`
     * request is treated as authorized regardless of its bearer token (or lack of one). Exists
     * only because some MCP clients' custom-connector UIs don't yet offer a way to attach a
     * static credential, only OAuth or no-auth-at-all — this is a temporary, explicit,
     * loudly-logged opt-out for a short manual test session, not a supported configuration.
     * Pass it inline on the command that starts the server; do not leave it set.
     */
    readonly disableAuthDangerously: boolean;
  };
}

/** Reads and validates configuration from the environment. Creates the database's parent directory if needed. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dbPath =
    env.CLAUDE_MEMORY_DB_PATH && env.CLAUDE_MEMORY_DB_PATH.trim() !== ''
      ? env.CLAUDE_MEMORY_DB_PATH
      : defaultDbPath();

  mkdirSync(dirname(dbPath), { recursive: true });

  const httpEnabled = readBool('CLAUDE_MEMORY_HTTP_ENABLED', false);
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

  const remoteMcpEnabled = readBool('CLAUDE_MEMORY_REMOTE_MCP_ENABLED', false);
  const remoteMcpToken = env.CLAUDE_MEMORY_REMOTE_MCP_TOKEN?.trim();

  if (remoteMcpEnabled && !remoteMcpToken) {
    throw new ConfigError(
      'CLAUDE_MEMORY_REMOTE_MCP_ENABLED is true but CLAUDE_MEMORY_REMOTE_MCP_TOKEN is not set. ' +
        'Refusing to start the remote MCP server without an auth token — it is meant to be reachable ' +
        'from the public internet (e.g. via a tunnel), unlike the stdio server.',
    );
  }

  const splitList = (raw: string | undefined): string[] =>
    (raw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

  return {
    dbPath,
    maxResults: readInt('CLAUDE_MEMORY_MAX_RESULTS', 50),
    maxImportBytes: readInt('CLAUDE_MEMORY_MAX_IMPORT_BYTES', 5_000_000),
    maxImportRecords: readInt('CLAUDE_MEMORY_MAX_IMPORT_RECORDS', 2000),
    importAllowedDirs: splitList(env.CLAUDE_MEMORY_IMPORT_DIRS),
    http: {
      enabled: httpEnabled,
      host:
        env.CLAUDE_MEMORY_HTTP_HOST && env.CLAUDE_MEMORY_HTTP_HOST.trim() !== ''
          ? env.CLAUDE_MEMORY_HTTP_HOST
          : '127.0.0.1',
      port: readInt('CLAUDE_MEMORY_HTTP_PORT', 8787),
      token,
      corsOrigins,
    },
    remoteMcp: {
      enabled: remoteMcpEnabled,
      host:
        env.CLAUDE_MEMORY_REMOTE_MCP_HOST && env.CLAUDE_MEMORY_REMOTE_MCP_HOST.trim() !== ''
          ? env.CLAUDE_MEMORY_REMOTE_MCP_HOST
          : '127.0.0.1',
      port: readInt('CLAUDE_MEMORY_REMOTE_MCP_PORT', 8789),
      token: remoteMcpToken,
      allowedHosts: splitList(env.CLAUDE_MEMORY_REMOTE_MCP_ALLOWED_HOSTS),
      allowedOrigins: splitList(env.CLAUDE_MEMORY_REMOTE_MCP_ALLOWED_ORIGINS),
      disableAuthDangerously: readBool('CLAUDE_MEMORY_REMOTE_MCP_DISABLE_AUTH_DANGEROUSLY', false),
    },
  };
}
