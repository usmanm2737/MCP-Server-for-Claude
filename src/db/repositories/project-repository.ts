import type { MemoryDatabase } from '../client.js';
import type { Project } from '../../domain/models.js';
import { newId, nowIso, slugify } from '../../utils/ids.js';
import { DuplicateError, NotFoundError } from '../../utils/errors.js';

interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  current_state: string | null;
  next_steps: string | null;
  created_at: string;
  updated_at: string;
}

function mapRow(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    currentState: row.current_state,
    nextSteps: row.next_steps,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ProjectRepository {
  constructor(private readonly db: MemoryDatabase) {}

  findByName(name: string): Project | null {
    const row = this.db.raw
      .prepare('SELECT * FROM projects WHERE name = ?')
      .get(name) as unknown as ProjectRow | undefined;
    return row ? mapRow(row) : null;
  }

  findById(id: string): Project | null {
    const row = this.db.raw.prepare('SELECT * FROM projects WHERE id = ?').get(id) as unknown as
      ProjectRow | undefined;
    return row ? mapRow(row) : null;
  }

  create(name: string, description?: string): Project {
    const existing = this.findByName(name);
    if (existing) {
      throw new DuplicateError(`Project already exists: ${name}`);
    }
    const id = newId();
    const slugBase = slugify(name);
    let slug = slugBase;
    let suffix = 1;
    while (this.db.raw.prepare('SELECT 1 FROM projects WHERE slug = ?').get(slug)) {
      slug = `${slugBase}-${++suffix}`;
    }
    const ts = nowIso();
    this.db.raw
      .prepare(
        `INSERT INTO projects (id, name, slug, description, current_state, next_steps, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)`,
      )
      .run(id, name, slug, description ?? null, ts, ts);
    return {
      id,
      name,
      slug,
      description: description ?? null,
      currentState: null,
      nextSteps: null,
      createdAt: ts,
      updatedAt: ts,
    };
  }

  /** Finds a project by name, creating it (with no description) if it doesn't exist yet. */
  getOrCreate(name: string): Project {
    const existing = this.findByName(name);
    if (existing) return existing;
    return this.create(name);
  }

  /** For read-only lookups: throws rather than silently creating an empty project. */
  requireByName(name: string): Project {
    const project = this.findByName(name);
    if (!project) throw new NotFoundError('Project', name);
    return project;
  }

  /** Used where the id comes from a URL path segment (HTTP routes) and must 404 rather than auto-create. */
  requireById(id: string): Project {
    const project = this.findById(id);
    if (!project) throw new NotFoundError('Project', id);
    return project;
  }

  updateState(id: string, currentState: string, nextSteps: string): Project {
    const ts = nowIso();
    this.db.raw
      .prepare('UPDATE projects SET current_state = ?, next_steps = ?, updated_at = ? WHERE id = ?')
      .run(currentState, nextSteps, ts, id);
    const updated = this.findById(id);
    if (!updated) throw new Error(`Project disappeared during update: ${id}`);
    return updated;
  }

  count(): number {
    const row = this.db.raw.prepare('SELECT COUNT(*) AS n FROM projects').get() as unknown as {
      n: number;
    };
    return row.n;
  }

  /** Project names, most recently updated first — used for the project-context resource listing. */
  listNames(limit: number): string[] {
    const rows = this.db.raw
      .prepare('SELECT name FROM projects ORDER BY updated_at DESC LIMIT ?')
      .all(limit) as unknown as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  /** Full project rows, most recently updated first — used by the HTTP `GET /api/v1/projects` route. */
  list(limit: number): Project[] {
    const rows = this.db.raw
      .prepare('SELECT * FROM projects ORDER BY updated_at DESC LIMIT ?')
      .all(limit) as unknown as ProjectRow[];
    return rows.map(mapRow);
  }
}
