import type { Router, Request, Response } from 'express';

import type { Container } from '../../container.js';

function parseLimit(raw: unknown, fallback: number, max: number): number {
  const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

export function registerProjectsRoute(router: Router, container: Container): void {
  // Express 5's router forwards a rejected async handler to the error middleware
  // automatically (no manual try/catch + next(err) needed) — see router/lib/layer.js.
  router.get('/projects', async (req: Request, res: Response) => {
    const limit = parseLimit(req.query.limit, 50, 200);
    const projects = await container.projectService.listProjects(limit);
    res.status(200).json({ projects, count: projects.length });
  });
}
