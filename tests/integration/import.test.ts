import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTestContainer } from '../helpers.js';
import { ImportRejectedError } from '../../src/utils/errors.js';

describe('ImportService: JSON conversation import', () => {
  it('creates one activity per message and reuses the session on a repeat import (idempotent)', async () => {
    const container = await makeTestContainer();
    const content = JSON.stringify({
      schemaVersion: 1,
      sessionId: 'sess-1',
      messages: [
        { role: 'user', content: 'How do I configure S3?' },
        { role: 'assistant', content: 'Create a bucket, then set a policy.' },
      ],
    });

    const first = await container.importService.importConversation({
      projectName: 'Alpha',
      content,
    });
    expect(first.created).toBe(2);
    expect(first.skippedDuplicates).toBe(0);

    const second = await container.importService.importConversation({
      projectName: 'Alpha',
      content,
    });
    expect(second.created).toBe(0);
    expect(second.skippedDuplicates).toBe(2);
    expect(second.sessionId).toBe(first.sessionId); // same external session id => reused session

    const stats = await container.projectService.getMemoryStats();
    expect(stats.counts.activities).toBe(2);
    expect(stats.counts.sessions).toBe(1);
  });

  it('rejects JSON that does not match the documented schemaVersion-1 shape', async () => {
    const container = await makeTestContainer();
    await expect(
      container.importService.importConversation({
        projectName: 'Alpha',
        content: JSON.stringify({ schemaVersion: 2, messages: [] }),
      }),
    ).rejects.toThrow(ImportRejectedError);
  });

  it('rejects malformed JSON', async () => {
    const container = await makeTestContainer();
    await expect(
      container.importService.importConversation({ projectName: 'Alpha', content: '{not json' }),
    ).rejects.toThrow(ImportRejectedError);
  });

  it('skips whitespace-only messages as rejected, not as a created activity', async () => {
    const container = await makeTestContainer();
    const content = JSON.stringify({
      schemaVersion: 1,
      messages: [
        { role: 'user', content: 'real content' },
        { role: 'assistant', content: '   ' },
      ],
    });
    const result = await container.importService.importConversation({
      projectName: 'Alpha',
      content,
    });
    expect(result.created).toBe(1);
    expect(result.rejected).toHaveLength(1);
  });
});

describe('ImportService: Markdown/text import', () => {
  it('imports a markdown note as a single activity, titled from its first heading', async () => {
    const container = await makeTestContainer();
    const result = await container.importService.importConversation({
      projectName: 'Alpha',
      content: '# Project Kickoff\n\nWe agreed on the initial architecture.',
      sourceFormat: 'markdown',
    });
    expect(result.created).toBe(1);
    const { activities } = await container.activityService.getRecentActivity({
      projectName: 'Alpha',
    });
    expect(activities[0]?.title).toBe('Project Kickoff');
  });

  it('imports plain text as a single activity', async () => {
    const container = await makeTestContainer();
    const result = await container.importService.importConversation({
      projectName: 'Alpha',
      content: 'Just a plain note with no structure.',
      sourceFormat: 'text',
    });
    expect(result.created).toBe(1);
  });

  it('rejects an empty file', async () => {
    const container = await makeTestContainer();
    await expect(
      container.importService.importConversation({
        projectName: 'Alpha',
        content: '   ',
        sourceFormat: 'text',
      }),
    ).rejects.toThrow(ImportRejectedError);
  });
});

describe('ImportService: size and record limits', () => {
  it('rejects inline content larger than maxImportBytes', async () => {
    const container = await makeTestContainer({ maxImportBytes: 10 });
    await expect(
      container.importService.importConversation({
        projectName: 'Alpha',
        content: 'this is definitely more than ten bytes',
        sourceFormat: 'text',
      }),
    ).rejects.toThrow(ImportRejectedError);
  });

  it('rejects a JSON import whose message count exceeds maxImportRecords', async () => {
    const container = await makeTestContainer({ maxImportRecords: 1 });
    const content = JSON.stringify({
      schemaVersion: 1,
      messages: [
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'two' },
      ],
    });
    await expect(
      container.importService.importConversation({ projectName: 'Alpha', content }),
    ).rejects.toThrow(ImportRejectedError);
  });
});

describe('ImportService: filePath handling', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cam-import-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads a real file and infers format from its extension', async () => {
    const container = await makeTestContainer();
    const filePath = join(dir, 'note.md');
    writeFileSync(filePath, '# From a file\n\nBody text.', 'utf8');
    const result = await container.importService.importConversation({
      projectName: 'Alpha',
      filePath,
    });
    expect(result.created).toBe(1);
  });

  it('rejects a missing file', async () => {
    const container = await makeTestContainer();
    await expect(
      container.importService.importConversation({
        projectName: 'Alpha',
        filePath: join(dir, 'does-not-exist.txt'),
      }),
    ).rejects.toThrow(ImportRejectedError);
  });

  it('rejects a file outside the configured import directories when CLAUDE_MEMORY_IMPORT_DIRS-style restriction is set', async () => {
    const otherDir = mkdtempSync(join(tmpdir(), 'cam-outside-'));
    try {
      const container = await makeTestContainer({ importAllowedDirs: [dir] });
      const outsideFile = join(otherDir, 'note.txt');
      writeFileSync(outsideFile, 'hello', 'utf8');
      await expect(
        container.importService.importConversation({ projectName: 'Alpha', filePath: outsideFile }),
      ).rejects.toThrow(ImportRejectedError);
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('allows a file inside the configured import directory', async () => {
    const container = await makeTestContainer({ importAllowedDirs: [dir] });
    const filePath = join(dir, 'allowed.txt');
    writeFileSync(filePath, 'hello from an allowed dir', 'utf8');
    const result = await container.importService.importConversation({
      projectName: 'Alpha',
      filePath,
    });
    expect(result.created).toBe(1);
  });
});
