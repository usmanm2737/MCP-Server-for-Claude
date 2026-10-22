import { describe, expect, it } from 'vitest';

import {
  deleteActivityInputSchema,
  importConversationInputSchema,
  importedConversationV1Schema,
} from '../../src/domain/schemas.js';

describe('importConversationInputSchema', () => {
  it('rejects when neither filePath nor content is given', () => {
    expect(importConversationInputSchema.safeParse({ projectName: 'Alpha' }).success).toBe(false);
  });

  it('rejects when both filePath and content are given', () => {
    const result = importConversationInputSchema.safeParse({
      projectName: 'Alpha',
      filePath: '/tmp/x.json',
      content: '{}',
    });
    expect(result.success).toBe(false);
  });

  it('accepts filePath alone', () => {
    expect(
      importConversationInputSchema.safeParse({ projectName: 'Alpha', filePath: '/tmp/x.json' })
        .success,
    ).toBe(true);
  });

  it('accepts content alone', () => {
    expect(
      importConversationInputSchema.safeParse({ projectName: 'Alpha', content: 'hi' }).success,
    ).toBe(true);
  });
});

describe('deleteActivityInputSchema', () => {
  it('requires confirm to be exactly literal true, not just truthy', () => {
    expect(deleteActivityInputSchema.safeParse({ activityId: 'a1', confirm: true }).success).toBe(
      true,
    );
    expect(deleteActivityInputSchema.safeParse({ activityId: 'a1', confirm: 1 }).success).toBe(
      false,
    );
    expect(deleteActivityInputSchema.safeParse({ activityId: 'a1', confirm: 'true' }).success).toBe(
      false,
    );
    expect(deleteActivityInputSchema.safeParse({ activityId: 'a1' }).success).toBe(false);
  });
});

describe('importedConversationV1Schema', () => {
  it('rejects an unsupported schemaVersion', () => {
    expect(
      importedConversationV1Schema.safeParse({
        schemaVersion: 2,
        messages: [{ role: 'user', content: 'hi' }],
      }).success,
    ).toBe(false);
  });

  it('rejects a message with an invalid role', () => {
    expect(
      importedConversationV1Schema.safeParse({
        schemaVersion: 1,
        messages: [{ role: 'narrator', content: 'hi' }],
      }).success,
    ).toBe(false);
  });

  it('rejects an empty messages array', () => {
    expect(importedConversationV1Schema.safeParse({ schemaVersion: 1, messages: [] }).success).toBe(
      false,
    );
  });
});
