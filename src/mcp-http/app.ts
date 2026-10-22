/**
 * Builds the Express app for the remote MCP (Streamable HTTP) entrypoint,
 * separated from `index.ts`'s `listen()` call so tests can mount it
 * directly without binding a real port. See `index.ts` for the full
 * rationale (why this is a separate process from stdio/REST, session
 * model, etc.).
 */
import { randomUUID } from 'node:crypto';

import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { Express, Request, Response } from 'express';

import type { AppConfig } from '../config/env.js';
import type { Container } from '../container.js';
import { createMcpServer } from '../mcp/server.js';
import { logger } from '../utils/logging.js';

/** Minimal fixed-window rate limiter, in-memory, keyed by client IP — see `src/http/app.ts` for the REST API's twin. */
function rateLimiter(windowMs: number, max: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req: Request, res: Response, next: () => void): void => {
    const key = req.ip ?? 'unknown';
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now >= entry.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }
    if (entry.count >= max) {
      const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfterSec));
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests.' } });
      return;
    }
    entry.count++;
    next();
  };
}

export function createRemoteMcpApp(container: Container, config: AppConfig): Express {
  const token = config.remoteMcp.token ?? '';
  const sessions = new Map<string, NodeStreamableHTTPServerTransport>();

  function unauthorized(res: Response): void {
    res
      .status(401)
      .json({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid bearer token.' } });
  }

  function isAuthorized(req: Request): boolean {
    const header = req.header('authorization') ?? '';
    const [scheme, presented] = header.split(' ');
    return scheme === 'Bearer' && presented === token;
  }

  async function getOrCreateTransport(req: Request): Promise<NodeStreamableHTTPServerTransport> {
    const sessionId = req.header('mcp-session-id');
    const existing = sessionId ? sessions.get(sessionId) : undefined;
    if (existing) return existing;

    // No/unknown session id: treat this as a fresh connection's `initialize` request.
    // A new McpServer per session is the pattern @modelcontextprotocol/node's own
    // README demonstrates — registration is cheap; the real state (the database)
    // lives once in `container`, shared across every session.
    const server = createMcpServer(container);
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSessionId) => {
        sessions.set(newSessionId, transport);
        logger.info('remote MCP session opened', { sessionId: newSessionId });
      },
      onsessionclosed: (closedSessionId) => {
        sessions.delete(closedSessionId);
        logger.info('remote MCP session closed', { sessionId: closedSessionId });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    return transport;
  }

  function requireExistingSession(
    req: Request,
    res: Response,
  ): NodeStreamableHTTPServerTransport | null {
    const sessionId = req.header('mcp-session-id');
    const transport = sessionId ? sessions.get(sessionId) : undefined;
    if (!transport) {
      res.status(400).json({ error: { message: 'Unknown or missing Mcp-Session-Id.' } });
      return null;
    }
    return transport;
  }

  const app = createMcpExpressApp({
    host: config.remoteMcp.host,
    allowedHosts:
      config.remoteMcp.allowedHosts.length > 0 ? [...config.remoteMcp.allowedHosts] : undefined,
    allowedOrigins:
      config.remoteMcp.allowedOrigins.length > 0 ? [...config.remoteMcp.allowedOrigins] : undefined,
  });

  // Unauthenticated on purpose (same posture as the REST API's /health): hosting
  // platforms like Render ping this to decide whether the service is up, before
  // any credentials are in play.
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  });

  const mcpRateLimit = rateLimiter(60_000, 120);

  app.post('/mcp', mcpRateLimit, (req: Request, res: Response) => {
    if (!isAuthorized(req)) {
      unauthorized(res);
      return;
    }
    getOrCreateTransport(req)
      .then((transport) => transport.handleRequest(req, res, req.body))
      .catch((err: unknown) => {
        logger.error('remote MCP POST handling failed', { error: String(err) });
        if (!res.headersSent) res.status(500).json({ error: { message: 'Internal error.' } });
      });
  });

  // Streamable HTTP also uses GET (server-initiated stream on an existing session)
  // and DELETE (explicit session termination) — both require an existing session.
  app.get('/mcp', mcpRateLimit, (req: Request, res: Response) => {
    if (!isAuthorized(req)) {
      unauthorized(res);
      return;
    }
    const transport = requireExistingSession(req, res);
    if (!transport) return;
    transport.handleRequest(req, res).catch((err: unknown) => {
      logger.error('remote MCP GET handling failed', { error: String(err) });
      if (!res.headersSent) res.status(500).json({ error: { message: 'Internal error.' } });
    });
  });

  app.delete('/mcp', mcpRateLimit, (req: Request, res: Response) => {
    if (!isAuthorized(req)) {
      unauthorized(res);
      return;
    }
    const transport = requireExistingSession(req, res);
    if (!transport) return;
    transport.handleRequest(req, res).catch((err: unknown) => {
      logger.error('remote MCP DELETE handling failed', { error: String(err) });
      if (!res.headersSent) res.status(500).json({ error: { message: 'Internal error.' } });
    });
  });

  return app;
}
