import type { Router, Request, Response, NextFunction } from 'express';

import type { Container } from '../../container.js';
import {
  httpCreateActivityInputSchema,
  httpIngestConversationInputSchema,
} from '../../domain/schemas.js';

/**
 * Write endpoints for the optional ingestion API. Both accept only inline,
 * structured JSON bodies — neither takes a filesystem path, unlike the MCP
 * `import_conversation` tool. A browser-extension integration (not built in
 * this milestone) would call these same two routes.
 */
export function registerIngestionRoutes(router: Router, container: Container): void {
  router.post('/ingest/conversation', (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = httpIngestConversationInputSchema.parse(req.body);
      const result = container.importService.importConversation(input);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post(
    '/projects/:projectId/activities',
    (req: Request, res: Response, next: NextFunction) => {
      try {
        const input = httpCreateActivityInputSchema.parse(req.body);
        const { activity, duplicate } = container.activityService.saveActivityForProjectId(
          req.params.projectId as string,
          input,
        );
        res.status(duplicate ? 200 : 201).json({
          id: activity.id,
          projectId: activity.projectId,
          createdAt: activity.createdAt,
          duplicate,
        });
      } catch (err) {
        next(err);
      }
    },
  );
}
