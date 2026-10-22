import { afterEach, describe, expect, it } from 'vitest';

import { connectTestClient, type TestMcpSession } from './helpers.js';

let session: TestMcpSession | undefined;

afterEach(async () => {
  if (session) {
    await session.close();
    session = undefined;
  }
});

describe('MCP server: project-context resource', () => {
  it('lists a resource entry for each known project', async () => {
    session = await connectTestClient();
    session.container.activityService.saveActivity({
      projectName: 'Alpha',
      activityType: 'note',
      title: 'x',
      summary: 'y',
    });

    const { resourceTemplates } = await session.client.listResourceTemplates();
    expect(resourceTemplates.some((t) => t.uriTemplate.includes('{projectName}'))).toBe(true);

    const { resources } = await session.client.listResources();
    expect(resources.some((r) => r.uri === 'memory://projects/Alpha/context')).toBe(true);
  });

  it('reads back the same context as the get_project_context tool', async () => {
    session = await connectTestClient();
    session.container.projectService.updateProjectState({
      projectName: 'Alpha',
      currentState: 'building',
      nextSteps: 'ship it',
    });

    const read = await session.client.readResource({
      uri: 'memory://projects/Alpha/context',
    });
    const first = read.contents[0];
    expect(first?.mimeType).toBe('application/json');
    const text = first && 'text' in first ? first.text : undefined;
    const parsed = JSON.parse(String(text));
    expect(parsed.project.currentState).toBe('building');
  });

  it('errors (protocol-level) when reading an unknown project, rather than returning empty content', async () => {
    session = await connectTestClient();
    await expect(
      session.client.readResource({ uri: 'memory://projects/Ghost/context' }),
    ).rejects.toThrow();
  });
});

describe('MCP server: resume_project prompt', () => {
  it('is listed and returns a user message mentioning the project', async () => {
    session = await connectTestClient();
    const { prompts } = await session.client.listPrompts();
    expect(prompts.some((p) => p.name === 'resume_project')).toBe(true);

    const result = await session.client.getPrompt({
      name: 'resume_project',
      arguments: { projectName: 'Alpha' },
    });
    expect(result.messages).toHaveLength(1);
    const text = result.messages[0]?.content;
    expect(text && 'text' in text ? text.text : '').toContain('Alpha');
  });

  it('works with no projectName argument (asks the client to ask the user)', async () => {
    session = await connectTestClient();
    const result = await session.client.getPrompt({ name: 'resume_project', arguments: {} });
    const content = result.messages[0]?.content;
    const text = content && 'text' in content ? content.text : '';
    expect(text).toMatch(/ask the user/i);
  });
});
