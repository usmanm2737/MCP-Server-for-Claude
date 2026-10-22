import type { Router, Request, Response } from 'express';

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
  // Express 5's router forwards a rejected async handler to the error middleware
  // automatically (no manual try/catch + next(err) needed) — see router/lib/layer.js.
  router.post('/ingest/conversation', async (req: Request, res: Response) => {
    const input = httpIngestConversationInputSchema.parse(req.body);
    const result = await container.importService.importConversation(input);
    res.status(201).json(result);
  });

  router.post('/projects/:projectId/activities', async (req: Request, res: Response) => {
    const input = httpCreateActivityInputSchema.parse(req.body);
    const { activity, duplicate } = await container.activityService.saveActivityForProjectId(
      req.params.projectId as string,
      input,
    );
    res.status(duplicate ? 200 : 201).json({
      id: activity.id,
      projectId: activity.projectId,
      createdAt: activity.createdAt,
      duplicate,
    });
  });
}
