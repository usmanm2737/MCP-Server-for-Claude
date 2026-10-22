import type { MemoryDatabase } from '../client.js';
import { isUniqueViolation } from '../pg-errors.js';
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

  async findByName(name: string): Promise<Project | null> {
    const row = await this.db.queryOne<ProjectRow>('SELECT * FROM projects WHERE name = $1', [
      name,
    ]);
    return row ? mapRow(row) : null;
  }

  async findById(id: string): Promise<Project | null> {
    const row = await this.db.queryOne<ProjectRow>('SELECT * FROM projects WHERE id = $1', [id]);
    return row ? mapRow(row) : null;
  }

  async create(name: string, description?: string): Promise<Project> {
    return this.db.transaction(async () => {
      const existing = await this.findByName(name);
      if (existing) {
        throw new DuplicateError(`Project already exists: ${name}`);
      }
      const id = newId();
      const slugBase = slugify(name);
      let slug = slugBase;
      let suffix = 1;
      while (await this.db.queryOne('SELECT 1 FROM projects WHERE slug = $1', [slug])) {
        slug = `${slugBase}-${++suffix}`;
      }
      const ts = nowIso();
      try {
        await this.db.query(
          `INSERT INTO projects (id, name, slug, description, current_state, next_steps, created_at, updated_at)
           VALUES ($1, $2, $3, $4, NULL, NULL, $5, $6)`,
          [id, name, slug, description ?? null, ts, ts],
        );
      } catch (err) {
        // A genuinely concurrent create() for the same name can race past the
        // findByName check above — real concurrency is the whole point of the
        // Postgres move, so this is reachable now in a way it never was with
        // the single-threaded-synchronous SQLite client. The UNIQUE constraint
        // is the actual source of truth here.
        if (isUniqueViolation(err, 'projects_name_key')) {
          throw new DuplicateError(`Project already exists: ${name}`);
        }
        throw err;
      }
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
    });
  }

  /** Finds a project by name, creating it (with no description) if it doesn't exist yet. */
  async getOrCreate(name: string): Promise<Project> {
    const existing = await this.findByName(name);
    if (existing) return existing;
    try {
      return await this.create(name);
    } catch (err) {
      if (err instanceof DuplicateError) {
        const nowExists = await this.findByName(name);
        if (nowExists) return nowExists;
      }
      throw err;
    }
  }

  /** For read-only lookups: throws rather than silently creating an empty project. */
  async requireByName(name: string): Promise<Project> {
    const project = await this.findByName(name);
    if (!project) throw new NotFoundError('Project', name);
    return project;
  }

  /** Used where the id comes from a URL path segment (HTTP routes) and must 404 rather than auto-create. */
  async requireById(id: string): Promise<Project> {
    const project = await this.findById(id);
    if (!project) throw new NotFoundError('Project', id);
    return project;
  }

  async updateState(id: string, currentState: string, nextSteps: string): Promise<Project> {
    const ts = nowIso();
    await this.db.query(
      'UPDATE projects SET current_state = $1, next_steps = $2, updated_at = $3 WHERE id = $4',
      [currentState, nextSteps, ts, id],
    );
    const updated = await this.findById(id);
    if (!updated) throw new Error(`Project disappeared during update: ${id}`);
    return updated;
  }

  async count(): Promise<number> {
    const row = await this.db.queryOne<{ n: number }>('SELECT COUNT(*)::int AS n FROM projects');
    return row?.n ?? 0;
  }

  /** Project names, most recently updated first — used for the project-context resource listing. */
  async listNames(limit: number): Promise<string[]> {
    const rows = await this.db.query<{ name: string }>(
      'SELECT name FROM projects ORDER BY updated_at DESC LIMIT $1',
      [limit],
    );
    return rows.map((r) => r.name);
  }

  /** Full project rows, most recently updated first — used by the HTTP `GET /api/v1/projects` route. */
  async list(limit: number): Promise<Project[]> {
    const rows = await this.db.query<ProjectRow>(
      'SELECT * FROM projects ORDER BY updated_at DESC LIMIT $1',
      [limit],
    );
    return rows.map(mapRow);
  }
}
