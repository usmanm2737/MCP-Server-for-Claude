import { logger } from '../utils/logging.js';
import { isAppError, toSafeErrorMessage } from '../utils/errors.js';

export interface ToolTextResult {
  // The SDK's CallToolResult/InputRequiredResult types carry a catch-all index
  // signature (their underlying wire schema is permissive) — without a matching
  // index signature here, a value typed as this named interface (as opposed to
  // an inline object literal) fails assignability to that union.
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** Wraps a JSON-shaped payload as a tool result: pretty JSON in `content`, plus the same object as `structuredContent`. */
export function toolOk<T extends object>(payload: T): ToolTextResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload as unknown as Record<string, unknown>,
  };
}

export function toolError(message: string): ToolTextResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Runs a tool handler body, converting any thrown/rejected error into a
 * `isError: true` tool result instead of letting it reach the transport —
 * known `AppError`s surface their message verbatim, anything else collapses
 * to a generic message so internals never leak to the client.
 */
export async function runTool(
  toolName: string,
  fn: () => Promise<ToolTextResult> | ToolTextResult,
): Promise<ToolTextResult> {
  try {
    return await fn();
  } catch (err) {
    if (!isAppError(err)) {
      logger.error('tool handler threw an unexpected error', {
        tool: toolName,
        error: String(err),
      });
    }
    return toolError(toSafeErrorMessage(err));
  }
}
