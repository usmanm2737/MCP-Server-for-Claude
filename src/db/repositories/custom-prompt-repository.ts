import type { MemoryDatabase } from '../client.js';
import type { CustomPrompt } from '../../domain/models.js';
import { newId, nowIso } from '../../utils/ids.js';

interface CustomPromptRow {
  id: string;
  name: string;
  title: string | null;
  description: string | null;
  template: string;
  created_at: string;
  updated_at: string;
}

function mapRow(row: CustomPromptRow): CustomPrompt {
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    description: row.description,
    template: row.template,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface UpsertCustomPromptInput {
  name: string;
  title: string | null;
  description: string | null;
  template: string;
}

export class CustomPromptRepository {
  constructor(private readonly db: MemoryDatabase) {}

  findByName(name: string): CustomPrompt | null {
    const row = this.db.raw
      .prepare('SELECT * FROM custom_prompts WHERE name = ?')
      .get(name) as unknown as CustomPromptRow | undefined;
    return row ? mapRow(row) : null;
  }

  /** Creates a new prompt, or updates the existing one with the same `name` in place (same id, fresh `updatedAt`). */
  upsert(input: UpsertCustomPromptInput): CustomPrompt {
    const existing = this.findByName(input.name);
    const ts = nowIso();

    if (existing) {
      this.db.raw
        .prepare(
          `UPDATE custom_prompts SET title = ?, description = ?, template = ?, updated_at = ? WHERE id = ?`,
        )
        .run(input.title, input.description, input.template, ts, existing.id);
      return { ...existing, ...input, updatedAt: ts };
    }

    const id = newId();
    this.db.raw
      .prepare(
        `INSERT INTO custom_prompts (id, name, title, description, template, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.name, input.title, input.description, input.template, ts, ts);
    return { id, ...input, createdAt: ts, updatedAt: ts };
  }

  /** All saved prompts — used once per session to register them alongside the built-in ones. */
  listAll(): CustomPrompt[] {
    const rows = this.db.raw
      .prepare('SELECT * FROM custom_prompts ORDER BY name ASC')
      .all() as unknown as CustomPromptRow[];
    return rows.map(mapRow);
  }

  countAll(): number {
    const row = this.db.raw.prepare('SELECT COUNT(*) AS n FROM custom_prompts').get() as unknown as {
      n: number;
    };
    return row.n;
  }
}
