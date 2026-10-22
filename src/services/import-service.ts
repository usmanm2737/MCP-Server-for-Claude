import { readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve } from 'node:path';

import type { MemoryDatabase } from '../db/client.js';
import type { ProjectRepository } from '../db/repositories/project-repository.js';
import type { SessionRepository } from '../db/repositories/session-repository.js';
import type { ActivityRepository } from '../db/repositories/activity-repository.js';
import type { ImportConversationInput, ImportSourceFormat } from '../domain/schemas.js';
import type { ImportAdapter } from '../ingestion/adapters/types.js';
import { JsonAdapter } from '../ingestion/adapters/json-adapter.js';
import { MarkdownAdapter } from '../ingestion/adapters/markdown-adapter.js';
import { TextAdapter } from '../ingestion/adapters/text-adapter.js';
import { contentHash } from '../utils/ids.js';
import { ImportRejectedError } from '../utils/errors.js';

export interface ImportResult {
  sessionId: string;
  created: number;
  skippedDuplicates: number;
  rejected: Array<{ reason: string }>;
  activityIds: string[];
}

export interface ImportServiceConfig {
  maxImportBytes: number;
  maxImportRecords: number;
  importAllowedDirs: readonly string[];
}

function detectFormatFromPath(path: string): ImportSourceFormat {
  const ext = extname(path).toLowerCase();
  if (ext === '.json') return 'json';
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  return 'text';
}

function detectFormatFromContent(content: string): ImportSourceFormat {
  return content.trim().startsWith('{') ? 'json' : 'text';
}

export class ImportService {
  private readonly adapters: Record<ImportSourceFormat, ImportAdapter> = {
    json: new JsonAdapter(),
    markdown: new MarkdownAdapter(),
    text: new TextAdapter(),
  };

  constructor(
    private readonly db: MemoryDatabase,
    private readonly projects: ProjectRepository,
    private readonly sessions: SessionRepository,
    private readonly activities: ActivityRepository,
    private readonly config: ImportServiceConfig,
  ) {}

  private readSource(input: ImportConversationInput): {
    rawText: string;
    format: ImportSourceFormat;
    sourceReference: string | null;
  } {
    if (input.filePath) {
      const resolvedPath = resolve(input.filePath);
      this.assertPathAllowed(resolvedPath);

      let stat;
      try {
        stat = statSync(resolvedPath);
      } catch {
        throw new ImportRejectedError(`File not found: ${input.filePath}`);
      }
      if (!stat.isFile()) {
        throw new ImportRejectedError(`Not a regular file: ${input.filePath}`);
      }
      if (stat.size > this.config.maxImportBytes) {
        throw new ImportRejectedError(
          `File is ${stat.size} bytes, which exceeds the ${this.config.maxImportBytes}-byte import limit.`,
        );
      }

      const rawText = readFileSync(resolvedPath, 'utf8');
      return {
        rawText,
        format: input.sourceFormat ?? detectFormatFromPath(resolvedPath),
        sourceReference: resolvedPath,
      };
    }

    const content = input.content ?? '';
    const byteLength = Buffer.byteLength(content, 'utf8');
    if (byteLength > this.config.maxImportBytes) {
      throw new ImportRejectedError(
        `Inline content is ${byteLength} bytes, which exceeds the ${this.config.maxImportBytes}-byte import limit.`,
      );
    }
    return {
      rawText: content,
      format: input.sourceFormat ?? detectFormatFromContent(content),
      sourceReference: null,
    };
  }

  private assertPathAllowed(resolvedPath: string): void {
    if (this.config.importAllowedDirs.length === 0) return;
    const allowed = this.config.importAllowedDirs.some((dir) => {
      const dirResolved = resolve(dir);
      const rel = relative(dirResolved, resolvedPath);
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    });
    if (!allowed) {
      throw new ImportRejectedError(
        `filePath is outside the configured import directories (CLAUDE_MEMORY_IMPORT_DIRS).`,
      );
    }
  }

  async importConversation(input: ImportConversationInput): Promise<ImportResult> {
    const { rawText, format, sourceReference } = this.readSource(input);
    const adapter = this.adapters[format];

    const parsed = adapter.parse(rawText, {
      providedSessionId: input.sessionId,
      sourceReference,
    });

    if (parsed.records.length > this.config.maxImportRecords) {
      throw new ImportRejectedError(
        `Import would create ${parsed.records.length} records, which exceeds the ${this.config.maxImportRecords}-record limit per import.`,
      );
    }

    return this.db.transaction(async () => {
      const project = await this.projects.getOrCreate(input.projectName);

      const session = await this.sessions.getOrCreateByExternalId({
        projectId: project.id,
        source: parsed.session.source,
        externalSessionId: parsed.session.externalSessionId ?? null,
        title: parsed.session.title ?? null,
        startedAt: parsed.session.startedAt ?? null,
        endedAt: parsed.session.endedAt ?? null,
        metadata: sourceReference ? { sourceReference } : {},
      });

      const rejected = [...parsed.rejected];
      const activityIds: string[] = [];
      let created = 0;
      let skippedDuplicates = 0;

      // Anchored on a *stable* identity (external session id, or the file path for
      // file-based imports) rather than `session.id` (a fresh internal uuid whenever
      // there's no external id to reuse a session by) — otherwise re-importing the
      // exact same inline content twice would mint a new session each time and never
      // be recognized as a duplicate, defeating idempotency.
      const stableSessionAnchor = parsed.session.externalSessionId ?? sourceReference ?? '';
      for (const [index, record] of parsed.records.entries()) {
        const hash = contentHash([
          project.id,
          stableSessionAnchor,
          String(index),
          record.activityType,
          record.content,
        ]);

        if (await this.activities.findByContentHash(project.id, hash)) {
          skippedDuplicates++;
          continue;
        }

        const activity = await this.activities.create({
          projectId: project.id,
          sessionId: session.id,
          source: parsed.session.source,
          activityType: record.activityType,
          title: record.title,
          summary: record.summary,
          content: record.content,
          sourceReference,
          contentHash: hash,
          metadata: record.metadata,
        });
        created++;
        activityIds.push(activity.id);
      }

      return { sessionId: session.id, created, skippedDuplicates, rejected, activityIds };
    });
  }
}
