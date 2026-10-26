import type { CustomPromptRepository } from '../db/repositories/custom-prompt-repository.js';
import type { CustomResourceRepository } from '../db/repositories/custom-resource-repository.js';
import type { CustomPrompt, CustomResource } from '../domain/models.js';
import type { SavePromptInput, SaveResourceInput } from '../domain/schemas.js';
import { slugify } from '../utils/ids.js';
import { ValidationError } from '../utils/errors.js';

const DEFAULT_MIME_TYPE = 'text/plain';

/**
 * Lets a connected client persist its own prompt templates and resource
 * content at runtime — no code change or rebuild — instead of only the two
 * hardcoded ones (`resume_project`, `project-context`) registered in
 * `src/mcp/server.ts`. Saved rows are loaded and registered on the live
 * `McpServer` the moment each new session connects (see
 * `src/mcp/prompts/custom-prompts.ts` / `src/mcp/resources/custom-resources.ts`),
 * so anything saved here is just as usable as a built-in prompt/resource —
 * including from a different client/session — once reconnected.
 *
 * `name` is slugified into the stable, unique identifier (also the
 * `memory://custom/{name}` resource URI segment); the original text is kept
 * as `title` when no explicit title is given, so lookups stay forgiving
 * while registration stays well-formed. Saving again under the same name
 * updates the existing prompt/resource in place rather than erroring —
 * deliberately, since the point is "just save it," not duplicate management.
 */
export class CustomContentService {
  constructor(
    private readonly prompts: CustomPromptRepository,
    private readonly resources: CustomResourceRepository,
  ) {}

  private slugOrThrow(name: string): string {
    const slug = slugify(name);
    if (!slug) {
      throw new ValidationError(`"${name}" does not contain any usable characters for a name.`);
    }
    return slug;
  }

  savePrompt(input: SavePromptInput): CustomPrompt {
    const name = this.slugOrThrow(input.name);
    return this.prompts.upsert({
      name,
      title: input.title?.trim() || input.name.trim(),
      description: input.description?.trim() || null,
      template: input.template.trim(),
    });
  }

  saveResource(input: SaveResourceInput): CustomResource {
    const name = this.slugOrThrow(input.name);
    return this.resources.upsert({
      name,
      title: input.title?.trim() || input.name.trim(),
      description: input.description?.trim() || null,
      content: input.content,
      mimeType: input.mimeType?.trim() || DEFAULT_MIME_TYPE,
    });
  }

  listPrompts(): CustomPrompt[] {
    return this.prompts.listAll();
  }

  listResources(): CustomResource[] {
    return this.resources.listAll();
  }
}
