import type { Express, Request, Response } from 'express';

/** Unauthenticated liveness check. Deliberately returns nothing beyond a status — no db path, no counts. */
export function registerHealthRoute(app: Express): void {
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  });
}
