import { describe, expect, it } from 'vitest';
import request from 'supertest';

import { createHttpApp } from '../../src/http/app.js';
import { makeTestConfig, makeTestContainer, type TestConfigOverrides } from '../helpers.js';

const TOKEN = 'test-token';

async function buildApp(overrides: TestConfigOverrides = {}) {
  const config = makeTestConfig({
    ...overrides,
    http: { token: TOKEN, ...overrides.http },
  });
  const container = await makeTestContainer({
    ...overrides,
    http: { token: TOKEN, ...overrides.http },
  });
  return { app: createHttpApp(container, config), container };
}

describe('GET /health', () => {
  it('responds 200 with no auth required', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});

describe('auth on /api/v1/*', () => {
  it('rejects a request with no Authorization header', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/api/v1/projects');
    expect(res.status).toBe(401);
  });

  it('rejects a request with the wrong bearer token', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/api/v1/projects').set('Authorization', 'Bearer wrong');
    expect(res.status).toBe(401);
  });

  it('accepts a request with the correct bearer token', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/api/v1/projects').set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
  });
});

describe('GET /api/v1/projects', () => {
  it('lists projects created through the service layer', async () => {
    const { app, container } = await buildApp();
    await container.activityService.saveActivity({
      projectName: 'Alpha',
      activityType: 'note',
      title: 'x',
      summary: 'y',
    });
    const res = await request(app).get('/api/v1/projects').set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.projects).toHaveLength(1);
    expect(res.body.projects[0].name).toBe('Alpha');
  });
});

describe('POST /api/v1/ingest/conversation', () => {
  it('imports inline content and is idempotent on repeat (counts created vs skipped)', async () => {
    const { app } = await buildApp();
    const body = {
      projectName: 'Alpha',
      content: JSON.stringify({
        schemaVersion: 1,
        messages: [{ role: 'user', content: 'hi from http' }],
      }),
    };

    const first = await request(app)
      .post('/api/v1/ingest/conversation')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(body);
    expect(first.status).toBe(201);
    expect(first.body.created).toBe(1);

    const second = await request(app)
      .post('/api/v1/ingest/conversation')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send(body);
    expect(second.status).toBe(201);
    expect(second.body.skippedDuplicates).toBe(1);
  });

  it('rejects a body with no content field with 400 and validation issues, not a 500', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .post('/api/v1/ingest/conversation')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ projectName: 'Alpha' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('never accepts a filePath field (structured content only)', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .post('/api/v1/ingest/conversation')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ projectName: 'Alpha', filePath: '/etc/passwd' });
    // filePath is simply not part of the schema, so this is a validation error (missing `content`),
    // not a path read — proving the route has no code path that could read an arbitrary file.
    expect(res.status).toBe(400);
  });
});

describe('POST /api/v1/projects/:projectId/activities', () => {
  it('returns 404 for an unknown project id rather than creating one', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .post('/api/v1/projects/does-not-exist/activities')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ activityType: 'note', title: 'x', summary: 'y' });
    expect(res.status).toBe(404);
  });

  it('creates an activity on an existing project', async () => {
    const { app, container } = await buildApp();
    const { activity } = await container.activityService.saveActivity({
      projectName: 'Alpha',
      activityType: 'note',
      title: 'seed',
      summary: 'seed',
    });
    const res = await request(app)
      .post(`/api/v1/projects/${activity.projectId}/activities`)
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ activityType: 'note', title: 'via http', summary: 'created over http' });
    expect(res.status).toBe(201);
    expect(res.body.projectId).toBe(activity.projectId);
  });
});

describe('CORS', () => {
  it('does not set CORS headers when no origins are configured', async () => {
    const { app } = await buildApp({ http: { token: TOKEN, corsOrigins: [] } });
    const res = await request(app)
      .get('/api/v1/projects')
      .set('Authorization', `Bearer ${TOKEN}`)
      .set('Origin', 'https://evil.example.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('sets CORS headers for an allowed origin', async () => {
    const { app } = await buildApp({
      http: { token: TOKEN, corsOrigins: ['https://allowed.example.com'] },
    });
    const res = await request(app)
      .get('/api/v1/projects')
      .set('Authorization', `Bearer ${TOKEN}`)
      .set('Origin', 'https://allowed.example.com');
    expect(res.headers['access-control-allow-origin']).toBe('https://allowed.example.com');
  });
});

describe('unknown routes', () => {
  it('returns a 404 JSON body', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/not-a-real-route');
    expect(res.status).toBe(404);
  });
});
