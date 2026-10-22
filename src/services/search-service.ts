import type { MemoryDatabase } from '../db/client.js';
import type { ProjectRepository } from '../db/repositories/project-repository.js';
import type { SearchActivityInput } from '../domain/schemas.js';
import type { SearchHit } from '../domain/models.js';

interface SearchRow {
  activity_id: string;
  project_id: string;
  project_name: string;
  activity_type: string;
  title: string;
  snippet: string;
  source: string;
  created_at: string;
}

const TS_HEADLINE_OPTIONS = 'StartSel=[, StopSel=], MaxFragments=1, MaxWords=15, MinWords=5';

export class SearchService {
  constructor(
    private readonly db: MemoryDatabase,
    private readonly projects: ProjectRepository,
    private readonly maxResults: number,
  ) {}

  /**
   * Returns `{ hits: [] , note }` (never throws) for an empty/unusable
   * query, an unknown project filter, or any filter combination that can't
   * match anything — "unknown results" are a graceful empty list with an
   * explanatory note, not an error.
   *
   * Query safety is delegated entirely to Postgres's `websearch_to_tsquery`:
   * it takes the raw user string directly (quotes, `-exclude`, `or`,
   * stray punctuation all handled per its own well-defined web-search
   * syntax) and degrades to an empty, harmlessly-unmatchable tsquery for
   * garbage input rather than erroring — no hand-rolled sanitizer needed
   * (a previous SQLite/FTS5-era version of this file had one; it's gone
   * because this function replaces what it was working around).
   */
  async search(input: SearchActivityInput): Promise<{ hits: SearchHit[]; note?: string }> {
    const trimmedQuery = input.query.trim();
    if (!trimmedQuery) {
      return { hits: [], note: 'Query had no searchable text.' };
    }

    let projectId: string | undefined;
    if (input.projectName) {
      const project = await this.projects.findByName(input.projectName);
      if (!project) {
        return { hits: [], note: `No project named "${input.projectName}" exists.` };
      }
      projectId = project.id;
    }

    const clauses = ["a.search_vector @@ websearch_to_tsquery('english', $1)"];
    const params: unknown[] = [trimmedQuery];

    if (projectId) {
      clauses.push(`a.project_id = $${params.length + 1}`);
      params.push(projectId);
    }
    if (input.activityType) {
      clauses.push(`a.activity_type = $${params.length + 1}`);
      params.push(input.activityType);
    }
    if (input.startDate) {
      clauses.push(`a.created_at >= $${params.length + 1}`);
      params.push(input.startDate);
    }
    if (input.endDate) {
      clauses.push(`a.created_at <= $${params.length + 1}`);
      params.push(input.endDate);
    }

    const limit = Math.min(input.limit ?? this.maxResults, this.maxResults);
    params.push(limit);

    let rows: SearchRow[];
    try {
      rows = await this.db.query<SearchRow>(
        `SELECT
           a.id AS activity_id,
           a.project_id AS project_id,
           p.name AS project_name,
           a.activity_type AS activity_type,
           a.title AS title,
           ts_headline('english', coalesce(a.content, a.summary),
             websearch_to_tsquery('english', $1), '${TS_HEADLINE_OPTIONS}') AS snippet,
           a.source AS source,
           a.created_at AS created_at
         FROM activities a
         JOIN projects p ON p.id = a.project_id
         WHERE ${clauses.join(' AND ')}
         ORDER BY ts_rank(a.search_vector, websearch_to_tsquery('english', $1)) DESC
         LIMIT $${params.length}`,
        params,
      );
    } catch {
      // Defense-in-depth: degrade to an empty result rather than a thrown
      // error reaching the client for any residual query-parsing issue.
      return { hits: [], note: 'Query could not be parsed as search text.' };
    }

    return {
      hits: rows.map((row) => ({
        activityId: row.activity_id,
        projectId: row.project_id,
        projectName: row.project_name,
        activityType: row.activity_type,
        title: row.title,
        snippet: row.snippet,
        source: row.source,
        createdAt: row.created_at,
      })),
    };
  }
}
