/** Domain types, one per table, plus the small set of status/priority unions used across them. */

export type TaskStatus = 'open' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';
export type DecisionStatus = 'proposed' | 'active' | 'superseded' | 'reverted';
export type ActivitySource = 'claude-code' | 'claude-web-import' | 'manual' | 'http-ingest';

export interface Project {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  currentState: string | null;
  nextSteps: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Session {
  id: string;
  projectId: string;
  source: string;
  externalSessionId: string | null;
  title: string | null;
  startedAt: string | null;
  endedAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface Activity {
  id: string;
  projectId: string;
  sessionId: string | null;
  source: string;
  activityType: string;
  title: string;
  summary: string;
  content: string | null;
  sourceReference: string | null;
  contentHash: string;
  metadata: Record<string, unknown>;
  tags: string[];
  createdAt: string;
  importedAt: string;
}

export interface Decision {
  id: string;
  projectId: string;
  activityId: string | null;
  decision: string;
  rationale: string | null;
  status: DecisionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  projectId: string;
  activityId: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface SearchHit {
  activityId: string;
  projectId: string;
  projectName: string;
  activityType: string;
  title: string;
  snippet: string;
  source: string;
  createdAt: string;
}

export interface ProjectContext {
  project: Pick<
    Project,
    'id' | 'name' | 'description' | 'currentState' | 'nextSteps' | 'updatedAt'
  >;
  recentActivities: Activity[];
  decisions: Decision[];
  openTasks: Task[];
  blockedTasks: Task[];
}

export interface MemoryStats {
  schemaVersion: number;
  /** Host/database name only, e.g. `postgresql://db.example.supabase.co:5432/postgres` — credentials are stripped, never the raw connection string. */
  dbPath: string;
  counts: {
    projects: number;
    sessions: number;
    activities: number;
    decisions: number;
    tasks: number;
  };
  oldestActivityAt: string | null;
  newestActivityAt: string | null;
  ftsIndexOk: boolean;
}
