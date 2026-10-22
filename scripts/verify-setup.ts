#!/usr/bin/env node
/**
 * End-to-end setup check: spawns the real built server (`dist/index.js`) as
 * a child process over stdio — the same way Claude Code runs it — and
 * exercises it with a real MCP client. Uses the configured database (the
 * same one `npm start` would use), but only ever touches one self-contained,
 * clearly-named row that it creates and then deletes again, so it never
 * leaves anything behind and never disturbs existing memory.
 *
 * Run after `npm run build`: `npm run verify-setup`.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const DIST_ENTRY = resolve(import.meta.dirname, '..', 'dist', 'index.js');
const MARKER_PROJECT = '__verify_setup__';

function logStep(message: string): void {
  process.stderr.write(`\n[verify-setup] ${message}\n`);
}

/** `StdioClientTransport` only forwards a safe minimal env subset by default — forward ours too, so the child sees the same CLAUDE_MEMORY_* config (e.g. from a loaded .env) this script's own process does. */
function currentEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

async function runChecks(client: Client): Promise<void> {
  const { tools } = await client.listTools();
  const expectedTools = [
    'save_activity',
    'search_activity',
    'get_project_context',
    'update_project_state',
    'get_recent_activity',
    'import_conversation',
    'delete_activity',
    'get_memory_stats',
  ];
  const toolNames = new Set(tools.map((t) => t.name));
  for (const expected of expectedTools) {
    if (!toolNames.has(expected)) throw new Error(`Tool "${expected}" is not registered.`);
  }
  logStep(`All ${expectedTools.length} tools registered.`);

  const { prompts } = await client.listPrompts();
  if (!prompts.some((p) => p.name === 'resume_project')) {
    throw new Error('Prompt "resume_project" is not registered.');
  }
  logStep('resume_project prompt registered.');

  const statsBefore = (await client.callTool({ name: 'get_memory_stats', arguments: {} }))
    .structuredContent as { dbPath: string; ftsIndexOk: boolean };
  logStep(`Using database: ${statsBefore.dbPath}`);
  if (!statsBefore.ftsIndexOk)
    throw new Error('Full-text search index failed its integrity check.');
  logStep('FTS5 search index OK.');

  const marker = `verify-setup ping ${new Date().toISOString()}`;
  const saveResult = await client.callTool({
    name: 'save_activity',
    arguments: {
      projectName: MARKER_PROJECT,
      activityType: 'note',
      title: marker,
      summary: marker,
    },
  });
  if (saveResult.isError)
    throw new Error(`save_activity failed: ${JSON.stringify(saveResult.content)}`);
  const { id: activityId } = saveResult.structuredContent as { id: string };
  logStep(`Saved a marker activity (id ${activityId}).`);

  try {
    const searchResult = await client.callTool({
      name: 'search_activity',
      arguments: { query: marker, projectName: MARKER_PROJECT },
    });
    const { count } = searchResult.structuredContent as { count: number };
    if (count !== 1)
      throw new Error(`Expected to find exactly 1 search hit for the marker, found ${count}.`);
    logStep('Marker activity is searchable via FTS5.');
  } finally {
    // Clean up the marker even if the search assertion above failed.
    const deleteResult = await client.callTool({
      name: 'delete_activity',
      arguments: { activityId, confirm: true },
    });
    if (deleteResult.isError) {
      logStep(
        `WARNING: failed to clean up marker activity ${activityId}: ${JSON.stringify(deleteResult.content)}`,
      );
    } else {
      logStep('Marker activity cleaned up.');
    }
  }
}

async function main(): Promise<void> {
  if (!existsSync(DIST_ENTRY)) {
    throw new Error(`${DIST_ENTRY} does not exist. Run "npm run build" first.`);
  }

  logStep(`Node ${process.version} (requires >=22.13 for node:sqlite without flags)`);
  logStep(`Spawning: node ${DIST_ENTRY}`);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [DIST_ENTRY],
    env: currentEnv(),
  });
  const client = new Client({ name: 'verify-setup', version: '0.0.0' });

  await client.connect(transport);
  logStep('Connected over stdio.');
  try {
    await runChecks(client);
  } finally {
    // Always close — this ends the child process's stdin, which per its own
    // documented behavior makes it exit. Without this, a failure above would
    // leave the spawned server process running forever.
    await client.close();
  }
}

main()
  .then(() => {
    logStep('All checks passed.\n');
    process.exit(0);
  })
  .catch((err: unknown) => {
    process.stderr.write(
      `\n[verify-setup] FAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(1);
  });
