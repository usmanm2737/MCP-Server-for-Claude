import type { AppConfig } from '../src/config/env.js';
import { buildInMemoryContainer, type Container } from '../src/container.js';

export type TestConfigOverrides = Partial<Omit<AppConfig, 'http' | 'remoteMcp'>> & {
  http?: Partial<AppConfig['http']>;
  remoteMcp?: Partial<AppConfig['remoteMcp']>;
};

export function makeTestConfig(overrides: TestConfigOverrides = {}): AppConfig {
  const { http: httpOverrides, remoteMcp: remoteMcpOverrides, ...rest } = overrides;
  return {
    dbPath: ':memory:',
    maxResults: 50,
    maxImportBytes: 5_000_000,
    maxImportRecords: 2000,
    importAllowedDirs: [],
    http: {
      enabled: false,
      host: '127.0.0.1',
      port: 8787,
      token: 'test-token',
      corsOrigins: [],
      ...httpOverrides,
    },
    remoteMcp: {
      enabled: false,
      host: '127.0.0.1',
      port: 8789,
      token: 'test-remote-mcp-token',
      allowedHosts: [],
      allowedOrigins: [],
      ...remoteMcpOverrides,
    },
    ...rest,
  };
}

/** A fresh in-memory database + fully wired container, isolated per test. Never touches a real file. */
export function makeTestContainer(overrides: TestConfigOverrides = {}): Container {
  return buildInMemoryContainer(makeTestConfig(overrides));
}
