import { z } from 'zod';

/**
 * Shared validation schemas: MCP tool inputs, the versioned conversation
 * import format, and primitives used by both the MCP tools and the HTTP
 * ingestion API so the two surfaces enforce identical rules.
 */

export const isoDateTime = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), { message: 'must be a valid ISO 8601 date/time' });

export const projectNameSchema = z.string().trim().min(1).max(200);
export const activityTypeSchema = z.string().trim().min(1).max(64);

// ---------------------------------------------------------------------------
// MCP tool inputs
// ---------------------------------------------------------------------------

export const saveActivityInputSchema = z.object({
  projectName: projectNameSchema,
  activityType: activityTypeSchema,
  title: z.string().trim().min(1).max(300),
  summary: z.string().trim().min(1).max(2000),
  content: z.string().max(200_000).optional(),
  source: z.string().trim().min(1).max(64).optional(),
  sessionId: z.string().trim().min(1).max(200).optional(),
  tags: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type SaveActivityInput = z.infer<typeof saveActivityInputSchema>;

export const searchActivityInputSchema = z.object({
  query: z.string().max(500),
  projectName: projectNameSchema.optional(),
  activityType: activityTypeSchema.optional(),
  startDate: isoDateTime.optional(),
  endDate: isoDateTime.optional(),
  limit: z.number().int().positive().max(200).optional(),
});
export type SearchActivityInput = z.infer<typeof searchActivityInputSchema>;

export const getProjectContextInputSchema = z.object({
  projectName: projectNameSchema,
  maxItems: z.number().int().positive().max(100).optional(),
});
export type GetProjectContextInput = z.infer<typeof getProjectContextInputSchema>;

export const updateProjectStateInputSchema = z.object({
  projectName: projectNameSchema,
  currentState: z.string().trim().min(1).max(5000),
  nextSteps: z.string().trim().min(1).max(5000),
  notes: z.string().max(5000).optional(),
});
export type UpdateProjectStateInput = z.infer<typeof updateProjectStateInputSchema>;

export const getRecentActivityInputSchema = z.object({
  projectName: projectNameSchema.optional(),
  activityType: activityTypeSchema.optional(),
  limit: z.number().int().positive().max(200).optional(),
});
export type GetRecentActivityInput = z.infer<typeof getRecentActivityInputSchema>;

export const importSourceFormatSchema = z.enum(['json', 'markdown', 'text']);
export type ImportSourceFormat = z.infer<typeof importSourceFormatSchema>;

export const importConversationInputSchema = z
  .object({
    projectName: projectNameSchema,
    filePath: z.string().trim().min(1).max(4096).optional(),
    content: z.string().max(10_000_000).optional(),
    sourceFormat: importSourceFormatSchema.optional(),
    sessionId: z.string().trim().min(1).max(200).optional(),
  })
  .refine((v) => Boolean(v.filePath) !== Boolean(v.content), {
    message: 'Provide exactly one of filePath or content, not both and not neither.',
  });
export type ImportConversationInput = z.infer<typeof importConversationInputSchema>;

export const deleteActivityInputSchema = z.object({
  activityId: z.string().trim().min(1).max(200),
  confirm: z.literal(true),
});
export type DeleteActivityInput = z.infer<typeof deleteActivityInputSchema>;

export const getMemoryStatsInputSchema = z.object({});
export type GetMemoryStatsInput = z.infer<typeof getMemoryStatsInputSchema>;

// ---------------------------------------------------------------------------
// Custom (user-saved) prompts and resources
// ---------------------------------------------------------------------------

/** Display name as given by the caller; slugified server-side into the stored, unique `name`/URI segment. */
const customDisplayNameSchema = z.string().trim().min(1).max(150);

export const savePromptInputSchema = z.object({
  name: customDisplayNameSchema,
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().min(1).max(1000).optional(),
  template: z.string().trim().min(1).max(50_000),
});
export type SavePromptInput = z.infer<typeof savePromptInputSchema>;

export const saveResourceInputSchema = z.object({
  name: customDisplayNameSchema,
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().min(1).max(1000).optional(),
  content: z.string().min(1).max(500_000),
  mimeType: z.string().trim().min(1).max(100).optional(),
});
export type SaveResourceInput = z.infer<typeof saveResourceInputSchema>;

// ---------------------------------------------------------------------------
// HTTP ingestion API bodies
//
// Deliberately distinct from the MCP tool schemas above: the HTTP routes
// never accept a filesystem path (see `src/http/routes/ingestion.ts`), only
// inline structured content, per the "no arbitrary filesystem access over
// HTTP" requirement.
// ---------------------------------------------------------------------------

export const httpIngestConversationInputSchema = z.object({
  projectName: projectNameSchema,
  content: z.string().min(1).max(10_000_000),
  sourceFormat: importSourceFormatSchema.optional(),
  sessionId: z.string().trim().min(1).max(200).optional(),
});
export type HttpIngestConversationInput = z.infer<typeof httpIngestConversationInputSchema>;

export const httpCreateActivityInputSchema = saveActivityInputSchema.omit({ projectName: true });
export type HttpCreateActivityInput = z.infer<typeof httpCreateActivityInputSchema>;

// ---------------------------------------------------------------------------
// Versioned conversation import format (JSON adapter)
//
// This is schemaVersion 1 of the file-based conversation import contract.
// Only this shape is accepted by the JSON adapter today; a future version
// bump must add a new `importedConversationV*Schema` and a matching adapter
// branch rather than changing this one in place, so old exports keep working.
// ---------------------------------------------------------------------------

export const importedMessageV1Schema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string().min(1).max(100_000),
  timestamp: isoDateTime.optional(),
});
export type ImportedMessageV1 = z.infer<typeof importedMessageV1Schema>;

export const importedConversationV1Schema = z.object({
  schemaVersion: z.literal(1),
  title: z.string().max(300).optional(),
  sessionId: z.string().max(200).optional(),
  source: z.string().max(64).optional(),
  startedAt: isoDateTime.optional(),
  endedAt: isoDateTime.optional(),
  messages: z.array(importedMessageV1Schema).min(1).max(2000),
});
export type ImportedConversationV1 = z.infer<typeof importedConversationV1Schema>;
