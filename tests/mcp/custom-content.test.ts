import { afterEach, describe, expect, it } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

import type { Container } from '../../src/container.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { makeTestContainer } from '../helpers.js';

/**
 * Connects a fresh `Client`/`McpServer` pair over the *same* container passed
 * in — i.e. the same underlying database — unlike `connectTestClient` in
 * `./helpers.js`, which always builds a brand-new container. That's exactly
 * what's needed here: `createMcpServer()` is called once per session in real
 * usage (see `src/mcp-http/app.ts`), and the whole point of save_prompt /
 * save_resource is that a *second*, later session over the same database
 * sees what an earlier one saved.
 */
async function connectSession(container: Container): Promise<Client> {
  const server = createMcpServer(container);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

let container: Container | undefined;
let clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  clients = [];
  container?.db.close();
  container = undefined;
});

describe('save_prompt + custom prompts', () => {
  it('persists the prompt, and a later session sees it as a real, callable MCP prompt', async () => {
    container = makeTestContainer();
    const session1 = await connectSession(container);
    clients.push(session1);

    const saveResult = await session1.callTool({
      name: 'save_prompt',
      arguments: { name: 'Daily Standup', template: 'Summarize what changed today.' },
    });
    expect(saveResult.isError).toBeFalsy();

    // A brand-new session/client over the same database — simulates reconnecting later.
    const session2 = await connectSession(container);
    clients.push(session2);

    const { prompts } = await session2.listPrompts();
    expect(prompts.some((p) => p.name === 'daily-standup')).toBe(true);

    const got = await session2.getPrompt({ name: 'daily-standup', arguments: {} });
    const content = got.messages[0]?.content;
    const text = content && 'text' in content ? content.text : '';
    expect(text).toBe('Summarize what changed today.');
  });

  it('saving again under the same name updates it in place, not a duplicate', async () => {
    container = makeTestContainer();
    const session1 = await connectSession(container);
    clients.push(session1);

    await session1.callTool({
      name: 'save_prompt',
      arguments: { name: 'Greeting', template: 'Hello v1' },
    });
    await session1.callTool({
      name: 'save_prompt',
      arguments: { name: 'Greeting', template: 'Hello v2' },
    });

    expect(container.customContentService.listPrompts()).toHaveLength(1);

    const session2 = await connectSession(container);
    clients.push(session2);
    const got = await session2.getPrompt({ name: 'greeting', arguments: {} });
    const content = got.messages[0]?.content;
    const text = content && 'text' in content ? content.text : '';
    expect(text).toBe('Hello v2');
  });
});

describe('save_resource + custom resources', () => {
  it('persists the resource, and a later session can read it at memory://custom/{name}', async () => {
    container = makeTestContainer();
    const session1 = await connectSession(container);
    clients.push(session1);

    const saveResult = await session1.callTool({
      name: 'save_resource',
      arguments: { name: 'API Notes', content: 'Base URL: https://example.com' },
    });
    expect(saveResult.isError).toBeFalsy();

    const session2 = await connectSession(container);
    clients.push(session2);

    const { resources } = await session2.listResources();
    expect(resources.some((r) => r.uri === 'memory://custom/api-notes')).toBe(true);

    const read = await session2.readResource({ uri: 'memory://custom/api-notes' });
    const first = read.contents[0];
    const text = first && 'text' in first ? first.text : undefined;
    expect(text).toBe('Base URL: https://example.com');
  });

  it('defaults mimeType to text/plain when not given', async () => {
    container = makeTestContainer();
    const session1 = await connectSession(container);
    clients.push(session1);

    await session1.callTool({
      name: 'save_resource',
      arguments: { name: 'Plain Thing', content: 'just text' },
    });

    expect(container.customContentService.listResources()[0]?.mimeType).toBe('text/plain');
  });
});
