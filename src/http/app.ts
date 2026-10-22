import { timingSafeEqual } from 'node:crypto';

import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import type { Container } from '../container.js';
import type { AppConfig } from '../config/env.js';
import { isAppError, toSafeErrorMessage } from '../utils/errors.js';
import { logger } from '../utils/logging.js';
import { registerHealthRoute } from './routes/health.js';
import { registerProjectsRoute } from './routes/projects.js';
import { registerIngestionRoutes } from './routes/ingestion.js';

function statusForError(err: unknown): number {
  if (!isAppError(err)) return 500;
  switch (err.code) {
    case 'NOT_FOUND':
      return 404;
    case 'DUPLICATE':
      return 409;
    case 'VALIDATION_ERROR':
    case 'IMPORT_REJECTED':
      return 400;
    default:
      return 500;
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Bearer-token auth for every `/api/v1/*` route (both reads and writes — stricter than the "writes only" floor). */
function requireAuth(token: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header('authorization') ?? '';
    const [scheme, presented] = header.split(' ');
    if (scheme !== 'Bearer' || !presented || !constantTimeEquals(presented, token)) {
      res
        .status(401)
        .json({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid bearer token.' } });
      return;
    }
    next();
  };
}

/** Rejects cross-origin browser requests unless the Origin is on the configured allowlist; no wildcard support. */
function cors(allowedOrigins: readonly string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.header('origin');
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  };
}

/** Minimal fixed-window rate limiter, in-memory, keyed by client IP. Fine for a single-process local API. */
function rateLimiter(windowMs: number, max: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req: Request, res: Response, next: NextFunction): void => {
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

export function createHttpApp(container: Container, config: AppConfig): express.Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(cors(config.http.corsOrigins));
  app.use(express.json({ limit: config.maxImportBytes + 4096 }));

  registerHealthRoute(app);

  const api = express.Router();
  api.use(requireAuth(config.http.token ?? ''));
  api.use(rateLimiter(60_000, 120));

  registerProjectsRoute(api, container);
  registerIngestionRoutes(api, container);

  app.use('/api/v1', api);

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such route.' } });
  });

  // Express error-handling middleware (4 args is the signature Express dispatches to on `next(err)` / thrown errors).
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request body failed validation.',
          issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      });
      return;
    }
    if (!isAppError(err)) {
      logger.error('http handler threw an unexpected error', {
        path: req.path,
        error: String(err),
      });
    }
    res.status(statusForError(err)).json({ error: { message: toSafeErrorMessage(err) } });
  });

  return app;
}
