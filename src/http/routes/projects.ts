import type { Router, Request, Response, NextFunction } from 'express';

import type { Container } from '../../container.js';

function parseLimit(raw: unknown, fallback: number, max: number): number {
  const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

export function registerProjectsRoute(router: Router, container: Container): void {
  router.get('/projects', (req: Request, res: Response, next: NextFunction) => {
    try {
      const limit = parseLimit(req.query.limit, 50, 200);
      const projects = container.projectService.listProjects(limit);
      res.status(200).json({ projects, count: projects.length });
    } catch (err) {
      next(err);
    }
  });
}
