import type { SQLInputValue } from 'node:sqlite';

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

/**
 * Turns free-text user input into a safe FTS5 MATCH expression: each
 * whitespace-delimited word is wrapped as its own quoted string literal
 * (doubling any embedded `"`), and the quoted words are ANDed together
 * (FTS5's default for space-separated terms).
 *
 * Deliberately does *not* strip or rewrite punctuation inside each word
 * before quoting it — FTS5 tokenizes the *contents* of a quoted literal
 * with the same tokenizer it used to index stored content, so handing it
 * the word verbatim (e.g. a timestamp like `2026-10-22T11:41:56.636Z`,
 * which the tokenizer itself splits on `-`/`:`/`.`) is what makes it match
 * the same way that text was indexed. Pre-stripping that punctuation here
 * would re-join sub-tokens the indexer kept apart and silently break the
 * match instead. What quoting *does* do: neutralize FTS5 operator syntax
 * a user's word might otherwise trigger (`AND`, `-foo`, `col:value`,
 * unbalanced quotes) by making it literal text rather than query syntax.
 *
 * Returns `null` when there is nothing to search for (empty/whitespace-only input).
 */
export function buildFtsQuery(rawQuery: string): string | null {
  const words = rawQuery
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (words.length === 0) return null;
  return words.map((w) => `"${w.replace(/"/g, '""')}"`).join(' ');
}

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
   */
  search(input: SearchActivityInput): { hits: SearchHit[]; note?: string } {
    const ftsQuery = buildFtsQuery(input.query);
    if (!ftsQuery) {
      return {
        hits: [],
        note: 'Query had no searchable text after removing punctuation/whitespace.',
      };
    }

    let projectId: string | undefined;
    if (input.projectName) {
      const project = this.projects.findByName(input.projectName);
      if (!project) {
        return { hits: [], note: `No project named "${input.projectName}" exists.` };
      }
      projectId = project.id;
    }

    const clauses = ['activities_fts MATCH ?'];
    const params: SQLInputValue[] = [ftsQuery];

    if (projectId) {
      clauses.push('a.project_id = ?');
      params.push(projectId);
    }
    if (input.activityType) {
      clauses.push('a.activity_type = ?');
      params.push(input.activityType);
    }
    if (input.startDate) {
      clauses.push('a.created_at >= ?');
      params.push(input.startDate);
    }
    if (input.endDate) {
      clauses.push('a.created_at <= ?');
      params.push(input.endDate);
    }

    const limit = Math.min(input.limit ?? this.maxResults, this.maxResults);
    params.push(limit);

    let rows: SearchRow[];
    try {
      rows = this.db.raw
        .prepare(
          `SELECT
             f.activity_id AS activity_id,
             a.project_id AS project_id,
             p.name AS project_name,
             a.activity_type AS activity_type,
             a.title AS title,
             snippet(activities_fts, -1, '[', ']', ' ... ', 12) AS snippet,
             a.source AS source,
             a.created_at AS created_at
           FROM activities_fts f
           JOIN activities a ON a.id = f.activity_id
           JOIN projects p ON p.id = a.project_id
           WHERE ${clauses.join(' AND ')}
           ORDER BY rank
           LIMIT ?`,
        )
        .all(...params) as unknown as SearchRow[];
    } catch {
      // Any residual FTS5 syntax error (e.g. a token that is still a bare
      // operator after sanitization) degrades to an empty result rather
      // than a thrown error reaching the client.
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
