import type { MemoryDatabase } from '../client.js';
import type { CustomResource } from '../../domain/models.js';
import { newId, nowIso } from '../../utils/ids.js';

interface CustomResourceRow {
  id: string;
  name: string;
  title: string | null;
  description: string | null;
  content: string;
  mime_type: string;
  created_at: string;
  updated_at: string;
}

function mapRow(row: CustomResourceRow): CustomResource {
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    description: row.description,
    content: row.content,
    mimeType: row.mime_type,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface UpsertCustomResourceInput {
  name: string;
  title: string | null;
  description: string | null;
  content: string;
  mimeType: string;
}

export class CustomResourceRepository {
  constructor(private readonly db: MemoryDatabase) {}

  findByName(name: string): CustomResource | null {
    const row = this.db.raw
      .prepare('SELECT * FROM custom_resources WHERE name = ?')
      .get(name) as unknown as CustomResourceRow | undefined;
    return row ? mapRow(row) : null;
  }

  /** Creates a new resource, or updates the existing one with the same `name` in place (same id, fresh `updatedAt`). */
  upsert(input: UpsertCustomResourceInput): CustomResource {
    const existing = this.findByName(input.name);
    const ts = nowIso();

    if (existing) {
      this.db.raw
        .prepare(
          `UPDATE custom_resources SET title = ?, description = ?, content = ?, mime_type = ?, updated_at = ? WHERE id = ?`,
        )
        .run(input.title, input.description, input.content, input.mimeType, ts, existing.id);
      return { ...existing, ...input, updatedAt: ts };
    }

    const id = newId();
    this.db.raw
      .prepare(
        `INSERT INTO custom_resources (id, name, title, description, content, mime_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.name, input.title, input.description, input.content, input.mimeType, ts, ts);
    return { id, ...input, createdAt: ts, updatedAt: ts };
  }

  /** All saved resources — used once per session to register them alongside the built-in one. */
  listAll(): CustomResource[] {
    const rows = this.db.raw
      .prepare('SELECT * FROM custom_resources ORDER BY name ASC')
      .all() as unknown as CustomResourceRow[];
    return rows.map(mapRow);
  }

  countAll(): number {
    const row = this.db.raw
      .prepare('SELECT COUNT(*) AS n FROM custom_resources')
      .get() as unknown as { n: number };
    return row.n;
  }
}
