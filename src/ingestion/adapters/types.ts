/**
 * Shared contract for conversation import adapters. Each adapter turns raw
 * text (already size-checked by the caller) into a session description
 * plus a bounded list of activity records; `ImportService` persists them.
 * Adding a new source format means adding a new adapter that satisfies this
 * interface, not changing `ImportService`.
 */

export interface ParsedSession {
  source: string;
  externalSessionId?: string;
  title?: string;
  startedAt?: string;
  endedAt?: string;
}

export interface ParsedActivityRecord {
  activityType: string;
  title: string;
  summary: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface ParsedImport {
  session: ParsedSession;
  records: ParsedActivityRecord[];
  /** Records present in the source but intentionally not turned into activities (e.g. empty messages), with a reason. */
  rejected: Array<{ reason: string }>;
}

export interface AdapterContext {
  /** Overrides the adapter's default session source, when the caller supplied one. */
  providedSource?: string;
  /** Overrides/links to an existing session via its external id. */
  providedSessionId?: string;
  /** File path or other human-readable origin, for titles/fallbacks only — never trusted as executable input. */
  sourceReference: string | null;
}

export interface ImportAdapter {
  readonly format: 'json' | 'markdown' | 'text';
  parse(rawText: string, ctx: AdapterContext): ParsedImport;
}
