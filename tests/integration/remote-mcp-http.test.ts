import type { AddressInfo } from 'node:net';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { createRemoteMcpApp } from '../../src/mcp-http/app.js';
import { makeTestConfig, makeTestContainer } from '../helpers.js';

const TOKEN = 'remote-test-token';

async function buildApp() {
  const config = makeTestConfig({ remoteMcp: { token: TOKEN } });
  const container = await makeTestContainer({ remoteMcp: { token: TOKEN } });
  return { app: createRemoteMcpApp(container, config), container };
}

describe('remote MCP HTTP: authentication', () => {
  it('rejects a POST /mcp with no Authorization header', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(401);
  });

  it('rejects a POST /mcp with the wrong bearer token', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .post('/mcp')
      .set('Authorization', 'Bearer wrong')
      .set('Content-Type', 'application/json')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(401);
  });

  it('rejects GET and DELETE /mcp without auth too', async () => {
    const { app } = await buildApp();
    const getRes = await request(app).get('/mcp');
    const deleteRes = await request(app).delete('/mcp');
    expect(getRes.status).toBe(401);
    expect(deleteRes.status).toBe(401);
  });
});

describe('remote MCP HTTP: full protocol round-trip over a real port', () => {
  let activeServer: ReturnType<ReturnType<typeof createRemoteMcpApp>['listen']> | undefined;
  let activeClient: Client | undefined;

  afterEach(async () => {
    if (activeClient) {
      await activeClient.close();
      activeClient = undefined;
    }
    if (activeServer) {
      await new Promise<void>((resolve) => activeServer?.close(() => resolve()));
      activeServer = undefined;
    }
  });

  it('lists all 8 tools and completes a save/search round-trip over a real session', async () => {
    const { app } = await buildApp();
    const server = app.listen(0, '127.0.0.1');
    activeServer = server;
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const { port } = server.address() as AddressInfo;

    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    });
    const client = new Client({ name: 'test-remote-client', version: '0.0.0' });
    activeClient = client;
    await client.connect(transport);

    const sessionIdAfterConnect = transport.sessionId;
    expect(sessionIdAfterConnect).toBeTruthy();

    const { tools } = await client.listTools();
    expect(tools).toHaveLength(8);

    const saveResult = await client.callTool({
      name: 'save_activity',
      arguments: {
        projectName: 'remote-http-test',
        activityType: 'note',
        title: 'Remote HTTP round-trip',
        summary: 'Saved over Streamable HTTP to confirm the remote entrypoint works end-to-end.',
      },
    });
    expect(saveResult.isError).toBeFalsy();

    const searchResult = await client.callTool({
      name: 'search_activity',
      arguments: { query: 'Remote HTTP round-trip', projectName: 'remote-http-test' },
    });
    expect((searchResult.structuredContent as { count: number }).count).toBe(1);

    // A second call on the same client must reuse the session, not mint a new one each time.
    await client.callTool({ name: 'get_memory_stats', arguments: {} });
    expect(transport.sessionId).toBe(sessionIdAfterConnect);
  });
});
