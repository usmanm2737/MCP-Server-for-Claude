import { basename } from 'node:path';

import { ImportRejectedError } from '../../utils/errors.js';
import { firstNonEmptyLine, truncate } from '../../utils/text.js';
import type { AdapterContext, ImportAdapter, ParsedImport } from './types.js';

/** Adapter for unstructured plain-text notes/exports. The whole file becomes one `note-import` activity. */
export class TextAdapter implements ImportAdapter {
  readonly format = 'text' as const;

  parse(rawText: string, ctx: AdapterContext): ParsedImport {
    const text = rawText.trim();
    if (text.length === 0) {
      throw new ImportRejectedError('File is empty.');
    }

    const title =
      firstNonEmptyLine(text) ??
      (ctx.sourceReference ? basename(ctx.sourceReference) : 'Imported note');

    return {
      session: {
        source: ctx.providedSource ?? 'claude-web-import',
        externalSessionId: ctx.providedSessionId,
        title: truncate(title, 300),
      },
      records: [
        {
          activityType: 'note-import',
          title: truncate(title, 300),
          summary: truncate(text, 300),
          content: rawText,
        },
      ],
      rejected: [],
    };
  }
}
