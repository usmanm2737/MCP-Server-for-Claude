import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

import type { AppConfig } from '../../src/config/env.js';
import type { Container } from '../../src/container.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { makeTestContainer } from '../helpers.js';

export interface TestMcpSession {
  client: Client;
  container: Container;
  close: () => Promise<void>;
}

/** Wires a real `Client` to a real `McpServer` over an in-memory linked transport pair — no stdio, no subprocess. */
export async function connectTestClient(
  overrides: Partial<AppConfig> = {},
): Promise<TestMcpSession> {
  const container = makeTestContainer(overrides);
  const server = createMcpServer(container);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    container,
    close: async () => {
      await client.close();
      container.db.close();
    },
  };
}
