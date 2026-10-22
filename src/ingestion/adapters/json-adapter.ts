import { importedConversationV1Schema } from '../../domain/schemas.js';
import { ImportRejectedError } from '../../utils/errors.js';
import { truncate } from '../../utils/text.js';
import type { AdapterContext, ImportAdapter, ParsedImport } from './types.js';

/**
 * Adapter for the documented, versioned JSON conversation export format
 * (`importedConversationV1Schema` in `src/domain/schemas.ts`). One message
 * becomes one activity record — this is deliberately granular (rather than
 * one activity per whole conversation) so `search_activity` can find and
 * snippet individual exchanges, not just whole-file matches.
 *
 * A future export shape gets a new `importedConversationV*Schema` and a new
 * branch here (or a new adapter), never a breaking change to this one.
 */
export class JsonAdapter implements ImportAdapter {
  readonly format = 'json' as const;

  parse(rawText: string, ctx: AdapterContext): ParsedImport {
    let data: unknown;
    try {
      data = JSON.parse(rawText);
    } catch {
      throw new ImportRejectedError('File is not valid JSON.');
    }

    const result = importedConversationV1Schema.safeParse(data);
    if (!result.success) {
      const firstIssue = result.error.issues[0];
      const detail = firstIssue
        ? `${firstIssue.path.join('.')}: ${firstIssue.message}`
        : 'unknown validation error';
      throw new ImportRejectedError(
        `JSON does not match the supported conversation import schema (schemaVersion 1): ${detail}`,
      );
    }

    const parsed = result.data;
    const rejected: ParsedImport['rejected'] = [];
    const records: ParsedImport['records'] = [];

    parsed.messages.forEach((message, index) => {
      const content = message.content.trim();
      if (content.length === 0) {
        rejected.push({ reason: `message[${index}]: empty content after trimming` });
        return;
      }
      records.push({
        activityType: 'conversation-message',
        title: `${message.role}: ${truncate(content, 80)}`,
        summary: truncate(content, 300),
        content: message.content,
        metadata: {
          role: message.role,
          index,
          ...(message.timestamp ? { timestamp: message.timestamp } : {}),
        },
      });
    });

    return {
      session: {
        source: ctx.providedSource ?? parsed.source ?? 'claude-web-import',
        externalSessionId: ctx.providedSessionId ?? parsed.sessionId,
        title: parsed.title,
        startedAt: parsed.startedAt,
        endedAt: parsed.endedAt,
      },
      records,
      rejected,
    };
  }
}
