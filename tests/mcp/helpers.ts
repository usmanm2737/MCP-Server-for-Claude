import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

import type { Container } from '../../src/container.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { makeTestContainer, type TestConfigOverrides } from '../helpers.js';

export interface TestMcpSession {
  client: Client;
  container: Container;
  close: () => Promise<void>;
}

/** Wires a real `Client` to a real `McpServer` over an in-memory linked transport pair — no stdio, no subprocess. */
export async function connectTestClient(
  overrides: TestConfigOverrides = {},
): Promise<TestMcpSession> {
  const container = await makeTestContainer(overrides);
  const server = createMcpServer(container);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    container,
    close: async () => {
      await client.close();
      // The shared test db pool is closed once per test file by tests/setup.ts's
      // afterAll — do not close it per-session here, or later tests in the same
      // file would run against a closed pool.
    },
  };
}
