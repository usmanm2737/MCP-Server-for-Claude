import { afterEach, describe, expect, it } from 'vitest';

import { connectTestClient, type TestMcpSession } from './helpers.js';

let session: TestMcpSession | undefined;

afterEach(async () => {
  if (session) {
    await session.close();
    session = undefined;
  }
});

describe('MCP server: tool registration', () => {
  it('lists all 10 documented tools', async () => {
    session = await connectTestClient();
    const { tools } = await session.client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'delete_activity',
        'get_memory_stats',
        'get_project_context',
        'get_recent_activity',
        'import_conversation',
        'save_activity',
        'save_prompt',
        'save_resource',
        'search_activity',
        'update_project_state',
      ].sort(),
    );
  });

  it('every tool has a non-empty description', async () => {
    session = await connectTestClient();
    const { tools } = await session.client.listTools();
    for (const tool of tools) {
      expect(tool.description?.length ?? 0).toBeGreaterThan(10);
    }
  });
});

describe('MCP server: save_activity + search_activity + get_recent_activity', () => {
  it('round-trips a saved activity through search', async () => {
    session = await connectTestClient();

    const saveResult = await session.client.callTool({
      name: 'save_activity',
      arguments: {
        projectName: 'Alpha',
        activityType: 'milestone',
        title: 'Launched beta',
        summary: 'Beta program opened to the first 50 signups.',
      },
    });
    expect(saveResult.isError).toBeFalsy();
    expect(saveResult.structuredContent).toMatchObject({ duplicate: false });

    const searchResult = await session.client.callTool({
      name: 'search_activity',
      arguments: { query: 'beta' },
    });
    expect(searchResult.isError).toBeFalsy();
    const structured = searchResult.structuredContent as { count: number };
    expect(structured.count).toBe(1);
  });
});

describe('MCP server: get_project_context', () => {
  it('returns isError for an unknown project rather than a protocol crash', async () => {
    session = await connectTestClient();
    const result = await session.client.callTool({
      name: 'get_project_context',
      arguments: { projectName: 'DoesNotExist' },
    });
    expect(result.isError).toBe(true);
  });
});

describe('MCP server: delete_activity requires confirm', () => {
  it('returns isError (schema validation failure) for a call missing confirm:true, rather than deleting anything', async () => {
    session = await connectTestClient();
    const result = await session.client.callTool({
      name: 'delete_activity',
      arguments: { activityId: 'whatever' },
    });
    // The SDK surfaces a tool inputSchema violation as a normal isError result, not a
    // rejected/thrown call — confirmed by exercising the real SDK here rather than assumed.
    expect(result.isError).toBe(true);
  });

  it('deletes a real activity when confirm:true is passed', async () => {
    session = await connectTestClient();
    const saved = await session.client.callTool({
      name: 'save_activity',
      arguments: {
        projectName: 'Alpha',
        activityType: 'note',
        title: 'Temp note',
        summary: 'to be deleted',
      },
    });
    const { id } = saved.structuredContent as { id: string };

    const deleted = await session.client.callTool({
      name: 'delete_activity',
      arguments: { activityId: id, confirm: true },
    });
    expect(deleted.isError).toBeFalsy();
  });
});

describe('MCP server: get_memory_stats', () => {
  it('reports counts and a healthy FTS index on a fresh database', async () => {
    session = await connectTestClient();
    const result = await session.client.callTool({ name: 'get_memory_stats', arguments: {} });
    const stats = result.structuredContent as {
      ftsIndexOk: boolean;
      counts: Record<string, number>;
    };
    expect(stats.ftsIndexOk).toBe(true);
    expect(stats.counts.projects).toBe(0);
  });
});

describe('MCP server: import_conversation', () => {
  it('imports inline JSON content and is idempotent on repeat', async () => {
    session = await connectTestClient();
    const content = JSON.stringify({
      schemaVersion: 1,
      messages: [{ role: 'user', content: 'Hello from a test' }],
    });

    const first = await session.client.callTool({
      name: 'import_conversation',
      arguments: { projectName: 'Alpha', content },
    });
    expect((first.structuredContent as { created: number }).created).toBe(1);

    const second = await session.client.callTool({
      name: 'import_conversation',
      arguments: { projectName: 'Alpha', content },
    });
    expect((second.structuredContent as { skippedDuplicates: number }).skippedDuplicates).toBe(1);
  });
});
