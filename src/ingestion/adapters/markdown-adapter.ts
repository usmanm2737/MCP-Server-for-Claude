import { basename } from 'node:path';

import { ImportRejectedError } from '../../utils/errors.js';
import { truncate } from '../../utils/text.js';
import type { AdapterContext, ImportAdapter, ParsedImport } from './types.js';

const HEADING_RE = /^#{1,6}\s+(.+?)\s*$/;

/**
 * Adapter for plain Markdown notes/exports with no structured message list.
 * The whole file becomes one `note-import` activity — there is no reliable,
 * format-agnostic way to split an arbitrary Markdown document into
 * conversation turns, so this adapter does not try to.
 */
export class MarkdownAdapter implements ImportAdapter {
  readonly format = 'markdown' as const;

  parse(rawText: string, ctx: AdapterContext): ParsedImport {
    const text = rawText.trim();
    if (text.length === 0) {
      throw new ImportRejectedError('File is empty.');
    }

    let title: string | undefined;
    let summarySource = text;
    for (const line of text.split(/\r?\n/)) {
      const match = HEADING_RE.exec(line);
      if (match?.[1]) {
        title = match[1];
        summarySource = text.slice(text.indexOf(line) + line.length).trim();
        break;
      }
    }
    if (!title) {
      title = ctx.sourceReference ? basename(ctx.sourceReference) : 'Imported note';
    }

    return {
      session: {
        source: ctx.providedSource ?? 'claude-web-import',
        externalSessionId: ctx.providedSessionId,
        title,
      },
      records: [
        {
          activityType: 'note-import',
          title: truncate(title, 300),
          summary: truncate(summarySource || text, 300),
          content: rawText,
        },
      ],
      rejected: [],
    };
  }
}
