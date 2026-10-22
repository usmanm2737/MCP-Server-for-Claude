# claude-activity-memory

An MCP (Model Context Protocol) server that gives Claude Code, claude.ai web, or any MCP client
persistent, searchable memory of project work — milestones, technical decisions, blockers, next steps —
stored in Postgres (Supabase works well, and is free), available again in a brand-new session, a
brand-new client, or a different Claude profile entirely.

**What this is not:** it does not watch a Claude.ai web browser session, and nothing in it runs
automatically just because it's installed. A connected client has to actually call its tools for
anything to be saved or retrieved. See [Known limitations](#known-limitations).

## Contents

- [Architecture](#architecture)
- [Requirements](#requirements)
- [Installation](#installation)
- [Database: Supabase/Postgres setup](#database-supabasepostgres-setup)
- [Configuration](#configuration)
- [Running the server](#running-the-server)
- [Claude Code integration](#claude-code-integration)
- [Verifying with the MCP Inspector](#verifying-with-the-mcp-inspector)
- [Using the tools](#using-the-tools)
- [The optional HTTP ingestion API](#the-optional-http-ingestion-api)
- [Testing with claude.ai web via a tunnel (ngrok)](#testing-with-claudeai-web-via-a-tunnel-ngrok)
- [Deploying to Render](#deploying-to-render)
- [Multiple Claude profiles at once](#multiple-claude-profiles-at-once)
- [Backups](#backups)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)
- [Roadmap](#roadmap)

## Architecture

```
┌─────────────────────────┐        ┌──────────────────────────┐
│   MCP client (stdio)    │◄──────►│  src/index.ts             │
│   e.g. Claude Code       │        │  (McpServer, stdio)       │
└─────────────────────────┘        └────────────┬─────────────┘
                                                 │
┌─────────────────────────┐        ┌────────────▼─────────────┐
│ REST client (optional,   │◄──────►│  src/http/index.ts        │
│ disabled by default)     │        │  (Express REST, auth req'd)│
└─────────────────────────┘        └────────────┬─────────────┘
                                                 │
┌─────────────────────────┐        ┌────────────▼─────────────┐
│ Remote MCP clients        │◄──────►│  src/mcp-http/index.ts    │
│ (claude.ai web, multiple │        │  (McpServer, Streamable   │
│  profiles/sessions at    │        │   HTTP, one session per   │
│  once — see below)       │        │   connection, auth req'd)  │
└─────────────────────────┘        └────────────┬─────────────┘
                                                 │
                                   ┌─────────────▼─────────────┐
                                   │   src/container.ts         │
                                   │   (composition root)       │
                                   └─────────────┬─────────────┘
                                                 │
                        ┌────────────────────────┼────────────────────────┐
                        ▼                        ▼                        ▼
             src/services/*.ts         src/ingestion/adapters/*   src/db/repositories/*.ts
          (application logic,                (json/markdown/text         (parameterized SQL,
           no SQL)                            import parsing)             one table each)
                        │                                                 │
                        └─────────────────────────┬───────────────────────┘
                                                    ▼
                                      src/db/client.ts (pg — Postgres)
                                  one shared database, FTS via tsvector/GIN
```

Three independent, optional entrypoints share one `Container` (built in `src/container.ts`) and one
Postgres database: `src/index.ts` (stdio, what Claude Code spawns locally), `src/http/index.ts` (the
bespoke REST ingestion API), and `src/mcp-http/index.ts` (the *actual* MCP protocol over HTTP — for
remote clients like claude.ai web, including several connected **at the same time**). Starting any one
of them never affects the others.

Layers, top to bottom:

- **MCP transport** (`src/mcp/`): registers 8 tools, 1 resource template, 1 prompt on an `McpServer` from
  `@modelcontextprotocol/server` (the current stable v2 SDK line — see [`src/mcp/server.ts`](src/mcp/server.ts)).
  Tool handlers call services; they never touch SQL directly.
- **Application services** (`src/services/`): the actual logic — dedup, fan-out from an activity into the
  decisions/tasks tables, search query building, import orchestration. Every method is `async` — the
  database is a network call now, not a local file.
- **Domain** (`src/domain/`): TypeScript types and every Zod input schema, shared by the MCP tools and the
  HTTP routes so both surfaces validate identically.
- **Repositories** (`src/db/repositories/`): one file per table, parameterized SQL only.
- **Database** (`src/db/client.ts`, `src/db/migrations/`): a thin wrapper over `pg` (node-postgres) with a
  concurrency-safe transaction helper (see below) and an embedded migration runner.
- **Ingestion adapters** (`src/ingestion/adapters/`): turn raw JSON/Markdown/text into a normalized
  `{session, records[]}` shape that `ImportService` persists.
- **Optional HTTP APIs** (`src/http/`, `src/mcp-http/`): separate entrypoints, never imported by the stdio
  entrypoint, so neither can interfere with the MCP stdio stream and both stay fully optional.

### Why Postgres (via Supabase) instead of SQLite

This project originally used Node's built-in `node:sqlite` — a good fit for "memory local to one
machine." It was changed to Postgres specifically to support **multiple Claude profiles/sessions
connecting to the same server at the same time, sharing memory** (the whole point of deploying this
remotely — see [Multiple Claude profiles at once](#multiple-claude-profiles-at-once)). A single SQLite
file is not meant for that kind of concurrent, networked, multi-client access; a real database is.
Supabase specifically because it's a hosted Postgres with a generous free tier and nothing proprietary
in how this project talks to it — it's just a connection string (`DATABASE_URL`) to a normal Postgres
database via the `pg` driver; any other Postgres host works identically.

### Why raw parameterized SQL instead of an ORM

The original brief allowed either Drizzle ORM or parameterized SQL, whichever is simpler and more
reliable. This schema is small (7 tables) — plain parameterized SQL through `pg` keeps the whole data
layer easy to read in one pass. See `src/db/repositories/*.ts`.

### Full-text search: `tsvector` + `websearch_to_tsquery`, not SQLite FTS5

`activities` has a generated `search_vector tsvector` column (title/summary/content, weighted) with a
GIN index, kept in sync by Postgres itself on every insert — no separate index table for the app to
maintain. Searches use `websearch_to_tsquery('english', <raw user query>)`, which takes the user's text
directly and safely interprets web-search-style syntax (quotes, `-exclude`, stray punctuation) on its
own — no hand-rolled query sanitizer needed. See `src/services/search-service.ts`.

### Concurrency-safe transactions

With a single local SQLite file accessed synchronously, "the current transaction" could safely be one
mutable field. With a Postgres connection pool serving several real concurrent requests (multiple
profiles connected at once — the reason for this whole migration), that would be a correctness bug: two
requests could stomp on each other's transaction state. `src/db/client.ts` instead tracks the active
transaction's client via `AsyncLocalStorage`, scoped per async call stack, and a nested `transaction()`
call uses a real `SAVEPOINT` rather than just joining the outer one.

### How `save_activity` populates decisions and tasks

There are exactly 8 MCP tools — no separate `create_decision` or `create_task` tool. Instead,
`save_activity`'s `activityType` field drives it: `"decision"` also writes a row to the decisions table;
`"task"` or `"blocker"` also writes a row to the tasks table (`"blocker"` as status `blocked`). This is
documented for the connected client in [`CLAUDE.md`](CLAUDE.md) and in each tool's own description (so a
client reading `tools/list` sees it without reading this README).

## Requirements

- **Node.js ≥ 22** (built and tested against Node 24.x — needed for the native `--env-file-if-exists`
  flag and TypeScript stripping that `npm run dev`/`dev:http`/`dev:remote-mcp` rely on; `npm start`
  against the compiled `dist/` output is less picky, but 22+ is the simplest safe bar).
- npm (ships with Node).
- **A reachable Postgres database.** [Supabase](https://supabase.com) free tier is the documented path
  (see next section); any Postgres ≥ 13 works (needs `tsvector`/GIN support, which is all versions in
  practice).
- No paid dependencies in the code itself — Supabase/Render/ngrok, if you use them, have their own free
  tiers sufficient for personal use, but are still third-party services you're choosing to depend on.

Check your Node version:

```bash
node --version
```

## Installation

macOS/Linux:

```bash
git clone <this-repo-url> claude-activity-memory
cd claude-activity-memory
npm install
cp .env.example .env
npm run build
```

Windows PowerShell:

```powershell
git clone <this-repo-url> claude-activity-memory
Set-Location claude-activity-memory
npm install
Copy-Item .env.example .env
npm run build
```

You'll fill in `.env` with a real `DATABASE_URL` in the next section before anything will actually start
— there is no local-file fallback.

## Database: Supabase/Postgres setup

1. Create a free account at [supabase.com](https://supabase.com) and create a new project (pick any
   name/region; note the database password you set — you'll need it in the connection string).
2. In the project dashboard: **Project Settings → Database → Connection string**, select the **URI**
   tab. Copy it — it looks like
   `postgresql://postgres:[YOUR-PASSWORD]@db.<project-ref>.supabase.co:5432/postgres`.
3. Put it in `.env`:
   ```
   DATABASE_URL=postgresql://postgres:your-real-password@db.your-project-ref.supabase.co:5432/postgres
   ```
4. That's it — there's no separate migration command to run. Every entrypoint applies pending schema
   migrations automatically on startup (`src/db/client.ts`'s `runMigrations`), the same way this project
   always worked with SQLite.

Supabase's connection pooler (the "Transaction" or "Session" mode connection string, if you prefer it
over the direct connection) works too — this app issues normal parameterized queries and short-lived
transactions, nothing the pooler would reject. If you use a different Postgres host, nothing above
changes except where you got the connection string from.

**Never commit a real `DATABASE_URL`** — it contains your database password. `.env` is gitignored for
exactly this reason.

## Configuration

All configuration is environment variables, read in [`src/config/env.ts`](src/config/env.ts) and loaded
from `.env` automatically via Node's native `--env-file-if-exists` flag (already wired into every
`npm run` script below — no `dotenv` dependency). See [`.env.example`](.env.example) for the full list
with defaults; the main ones:

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | *(required, no default)* | Postgres connection string |
| `CLAUDE_MEMORY_DB_SSL` | `require` | `require` (encrypted, lenient cert check — right for Supabase) / `strict` / `disable` |
| `CLAUDE_MEMORY_MAX_RESULTS` | `50` | hard cap on rows returned by search/list tools |
| `CLAUDE_MEMORY_MAX_IMPORT_BYTES` | `5000000` | max accepted size for one import |
| `CLAUDE_MEMORY_MAX_IMPORT_RECORDS` | `2000` | max records one import may create |
| `CLAUDE_MEMORY_IMPORT_DIRS` | *(unset = unrestricted)* | comma-separated allowed directories for `import_conversation`'s `filePath` |
| `CLAUDE_MEMORY_HTTP_ENABLED` | `false` | must be `true` to let `npm run start:http` bind a port at all |
| `CLAUDE_MEMORY_HTTP_TOKEN` | *(none — required if HTTP is enabled)* | bearer token for the REST API |
| `CLAUDE_MEMORY_REMOTE_MCP_ENABLED` | `false` | must be `true` to let `npm run start:remote-mcp` bind a port at all |
| `CLAUDE_MEMORY_REMOTE_MCP_TOKEN` | *(none — required if enabled)* | bearer token every connecting profile/session uses |
| `CLAUDE_MEMORY_REMOTE_MCP_ALLOWED_HOSTS` | *(empty)* | your tunnel's/deployment's hostname — required or every remote request gets `403` |

**Never commit `.env`** — it's gitignored. `.env.example` has no real values and is safe to commit.

## Running the server

Build once, then run the compiled server (this is what a real MCP client spawns):

```bash
npm run build
npm start
```

For local iteration without rebuilding on every change (uses Node's native TypeScript stripping — no
`ts-node`/`tsx` dependency):

```bash
npm run dev
```

The stdio server logs structured JSON lines to **stderr only** (never stdout — stdout is the JSON-RPC
wire). If you ever see non-JSON-RPC text on stdout from this process, that's a bug; please report it.

## Claude Code integration

1. Build the project (`npm run build`) so `dist/index.js` exists, and `.env` has a real `DATABASE_URL`.
2. Register it, with the Claude Code CLI, using this repo's real absolute path:

   ```bash
   claude mcp add claude-activity-memory --scope project -- node /absolute/path/to/claude-activity-memory/dist/index.js
   ```

   Or copy [`.mcp.json.example`](.mcp.json.example) to `.mcp.json` in your project and fill in your own
   absolute paths — `.mcp.json` is gitignored (it tends to contain machine-specific paths), while
   `.mcp.json.example` is the safe-to-commit template.
3. Restart/reconnect your Claude Code session, then confirm the tools are actually visible (`/mcp`, or
   just ask the connected assistant to call `get_memory_stats`).
4. Read [`CLAUDE.md`](CLAUDE.md) — it's written *for* Claude Code: when to save, what never to save, how
   to treat imported content, and the explicit warning that **nothing here guarantees automatic
   capture** — a tool only runs when the client calls it.

## Verifying with the MCP Inspector

The [MCP Inspector](https://www.npmjs.com/package/@modelcontextprotocol/inspector) is the standard way to
poke at tools/resources/prompts by hand, independent of any particular client:

```bash
npm run build
npx @modelcontextprotocol/inspector node dist/index.js
```

This opens a local web UI where you can call each of the 8 tools with example arguments, read the
`memory://projects/{projectName}/context` resource, and fetch the `resume_project` prompt — useful for
confirming the server behaves as documented before wiring it into a client.

There's also a non-interactive, scripted equivalent that this project ships and that was used to verify
the server end-to-end during development — see `scripts/verify-setup.ts`, next.

### Automated setup check

```bash
npm run build
npm run verify-setup
```

This spawns the real built server over stdio (the same way Claude Code does), confirms all 8 tools and
the prompt are registered, checks full-text search's health, and round-trips one self-cleaning marker
activity through save → search → delete against **your actual configured database** — then removes the
marker. It leaves nothing behind either way (on failure, it still deletes the marker it created before
reporting the error). Exit code is non-zero on any failure.

## Using the tools

All 8 tools, their inputs, and their behavior are documented in their own descriptions (visible via
`tools/list` from any connected client) and in [`CLAUDE.md`](CLAUDE.md#while-working). Two concrete
walkthroughs:

### Save and search an activity

Via the Inspector or any connected client, call:

```jsonc
// save_activity
{
  "projectName": "My Project",
  "activityType": "decision",
  "title": "Use Postgres instead of a local file",
  "summary": "Needed multiple Claude profiles to share memory concurrently; a local SQLite file can't do that."
}
```

This creates the project (if new), the activity, and — because `activityType` is `"decision"` — a row in
the decisions table. Then:

```jsonc
// search_activity
{ "query": "Postgres" }
```

returns that activity with a snippet. Calling `save_activity` again with the exact same
project/activityType/title/summary/content is a no-op: the response comes back with `"duplicate": true`
and the original activity's id, nothing new is inserted.

### Import the bundled sample conversation

[`examples/sample-conversation.json`](examples/sample-conversation.json) is a small, valid
schemaVersion-1 JSON conversation export. Import it with:

```jsonc
// import_conversation
{ "projectName": "DemoProject", "filePath": "/absolute/path/to/claude-activity-memory/examples/sample-conversation.json" }
```

This creates one activity per message (4 of them) under one new session, and reports
`{"created": 4, "skippedDuplicates": 0, "rejected": []}`. Run the exact same call again and it reports
`{"created": 0, "skippedDuplicates": 4}` — imports are idempotent.

### Retrieve project context in a new session

In a *different* session/client connected to the same database:

```jsonc
// get_project_context
{ "projectName": "DemoProject" }
```

returns the project's description/state/next-steps, its recent activities (summaries only — not full
message bodies, so this stays bounded), open/blocked tasks, and active decisions. For an unknown project
name this returns an error result rather than silently creating an empty project.

## The optional HTTP ingestion API

Disabled by default. It is a **separate process/entrypoint** (`src/http/index.ts`) from the stdio MCP
server — starting it never affects, and is never affected by, an MCP client connection.

Enable it by setting, in `.env`:

```
CLAUDE_MEMORY_HTTP_ENABLED=true
CLAUDE_MEMORY_HTTP_TOKEN=<generate one yourself — see below>
```

Generate a token (there is no built-in default — the server refuses to start with HTTP enabled and no
token configured, even for localhost-only use):

```bash
node -e "console.log(require('crypto').randomUUID())"
```

Start it:

```bash
npm run build
npm run start:http
```

It binds to `127.0.0.1` by default (`CLAUDE_MEMORY_HTTP_HOST` to change — think carefully before binding
anything but a loopback address, since there's no built-in TLS). Every route under `/api/v1/*` —
reads and writes alike — requires `Authorization: Bearer <token>`; only `GET /health` is unauthenticated,
and deliberately returns nothing but `{"status":"ok"}`.

```bash
curl http://127.0.0.1:8787/health

curl -X POST http://127.0.0.1:8787/api/v1/ingest/conversation \
  -H "Authorization: Bearer $CLAUDE_MEMORY_HTTP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"projectName":"DemoProject","content":"{\"schemaVersion\":1,\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}]}"}'
```

Routes: `GET /health`, `GET /api/v1/projects`, `POST /api/v1/ingest/conversation`,
`POST /api/v1/projects/:projectId/activities`. The ingestion routes accept **only inline structured
JSON** — there is no `filePath` field anywhere in the HTTP API, unlike the MCP `import_conversation` tool;
this is deliberate (see `src/http/routes/ingestion.ts`), so the HTTP surface can never be used to make the
server read an arbitrary file. CORS is same-origin-only (no browser cross-origin access) unless you set
`CLAUDE_MEMORY_HTTP_CORS_ORIGINS` to an explicit allow-list — wildcard (`*`) is rejected at startup. A
simple in-memory rate limiter (120 req/min/IP) and request timeouts (30s) apply to every route.

A browser-extension integration is **not** built in this milestone; these two routes are the contract a
future one would use (see [Roadmap](#roadmap)).

## Testing with claude.ai web via a tunnel (ngrok)

Claude Code connects to this server by **spawning it locally** (stdio) — a browser can't do that.
claude.ai's web app instead needs a server reachable over **HTTPS**, speaking the actual MCP protocol
(not the REST API above). `src/mcp-http/index.ts` is that: a third, separate, also-optional entrypoint
that serves the exact same 8 tools/resource/prompt over the MCP "Streamable HTTP" transport, with one
session per connecting client — this is also what lets [multiple Claude profiles connect at
once](#multiple-claude-profiles-at-once). This has been tested end-to-end locally (real HTTP session,
real auth, real tool calls — see `tests/integration/remote-mcp-http.test.ts`); the ngrok + claude.ai
steps below involve claude.ai's own UI, which can change independently of this project, so verify the
exact screen names yourself as you go.

### 1. Enable and start the remote MCP server

In `.env` (in addition to `DATABASE_URL`, already set from the Supabase step above):

```
CLAUDE_MEMORY_REMOTE_MCP_ENABLED=true
CLAUDE_MEMORY_REMOTE_MCP_TOKEN=<generate one, same way as the REST API token>
```

```bash
npm run build
npm run start:remote-mcp
```

It binds to `127.0.0.1:8789` by default. Leave it on `127.0.0.1` — ngrok's agent runs on your machine too
and forwards from its public URL to this local port, so the server itself never needs to bind a public
address.

### 2. Start an ngrok tunnel pointed at it

Install ngrok (`https://ngrok.com/download`) and authenticate it once (`ngrok config add-authtoken
<your token>`, from your ngrok dashboard), then:

```bash
ngrok http 8789
```

ngrok prints a public URL like `https://abcd1234.ngrok-free.app`. Your MCP endpoint is that URL plus
`/mcp` — e.g. `https://abcd1234.ngrok-free.app/mcp`.

### 3. Allow that hostname through DNS-rebinding protection

The server rejects requests whose `Host` header isn't on an explicit allow-list — ngrok's hostname isn't
`localhost`, so without this step every tunneled request gets a `403`. Add it to `.env` (the free ngrok
hostname changes every time you restart the tunnel unless you pay for a reserved one, so expect to update
this often):

```
CLAUDE_MEMORY_REMOTE_MCP_ALLOWED_HOSTS=abcd1234.ngrok-free.app
```

Restart `npm run start:remote-mcp` after changing it.

### 4. Add it to claude.ai

In claude.ai web: **Settings → Connectors → Add custom connector** (the exact path/name has moved before
and may again — look for "connectors," "integrations," or "custom MCP server" if this doesn't match what
you see). Give it your ngrok URL with `/mcp` on the end. **What claude.ai currently requires here for
authentication is the one thing in this whole guide I can't promise from here** — this server expects a
plain `Authorization: Bearer <token>` header, which is the simplest case; if claude.ai's connector UI
only offers full OAuth for custom connectors by the time you try this, that's a bigger follow-up (a
proper OAuth provider on this server) rather than a config tweak. Try the bearer-token path first and see
what the UI actually asks for.

### Shutting it down

Close the ngrok tunnel (`Ctrl+C` in its terminal) and stop `start:remote-mcp` when you're done — neither
runs unless you start it, and the ngrok URL stops working the moment the tunnel closes. Don't leave a
tunnel open longer than you're actively testing; anyone with that URL and your token can call every tool,
including `delete_activity` and `update_project_state`.

## Deploying to Render

For an **always-on** remote MCP server (no laptop-with-a-tunnel-open required) — [render.yaml](render.yaml)
in this repo is a ready-to-use [Render Blueprint](https://render.com/docs/blueprint-spec) for exactly
this, deploying `src/mcp-http/index.ts` (the remote MCP entrypoint) as a web service.

1. Push this repo to GitHub (or GitLab/Bitbucket) if you haven't already.
2. In the [Render dashboard](https://dashboard.render.com): **New → Blueprint**, point it at your repo.
   Render reads `render.yaml` and proposes the `claude-activity-memory` web service.
3. Before (or right after) the first deploy, fill in the environment variables `render.yaml` marks as
   `sync: false` (Render's dashboard → your service → **Environment**):
   - `DATABASE_URL` — your Supabase connection string (see
     [Database: Supabase/Postgres setup](#database-supabasepostgres-setup)).
   - `CLAUDE_MEMORY_REMOTE_MCP_TOKEN` — generate one the same way as everywhere else in this README.
   - `CLAUDE_MEMORY_REMOTE_MCP_ALLOWED_HOSTS` — your service's hostname, e.g.
     `claude-activity-memory.onrender.com` (visible on the service's page; predictable from whatever name
     you gave it in step 2). Every request gets `403` until this is set, exactly like the ngrok case.
4. Deploy. Render builds (`npm install && npm run build`) and starts (`npm run start:remote-mcp`)
   automatically, and pings `GET /health` to confirm it's up.
5. Your MCP endpoint is `https://<your-service>.onrender.com/mcp` — use it in claude.ai's **Add custom
   connector** exactly as in the ngrok walkthrough above, minus the tunnel.

Render's free web service tier spins down after inactivity and takes a few seconds to wake back up on the
next request — fine for personal use, worth knowing if the first call after a while feels slow. The REST
ingestion API (`src/http/index.ts`) isn't deployed by this blueprint; add a second `services:` entry with
`startCommand: npm run start:http` and its own env vars if you want that hosted too.

## Multiple Claude profiles at once

The remote MCP entrypoint (`src/mcp-http/`) gives each connecting client its own session (tracked by the
`Mcp-Session-Id` the Streamable HTTP transport issues — see `src/mcp-http/app.ts`), but every session
reads and writes the **same** Postgres database. That's the model this project uses:

- **One shared memory, many simultaneous connections.** Open this server from your work laptop and your
  personal machine, or from two different Claude profiles, at the same time — both see the same
  projects/activities, and both can save/search concurrently without stepping on each other (that's what
  the `AsyncLocalStorage`-based transaction handling and `SAVEPOINT`-based nesting in `src/db/client.ts`
  are specifically for).
- **Not per-user private memory.** There is no login system, no per-profile data isolation, and no
  concept of "whose" project something is beyond the `projectName`/`activityType` you choose when saving.
  Anyone with the bearer token can read and write everything. If you need separate, private memory per
  person/profile instead of one shared pool, that's a different (larger) feature — a real per-user auth
  scheme plus a tenant/owner column threaded through every table — not what's built here.
- **Same token for everyone.** `CLAUDE_MEMORY_REMOTE_MCP_TOKEN` is one shared secret; there's no
  per-profile token issuance. Rotate it (generate a new one, update every connected client) if you ever
  suspect it's leaked.

## Backups

Supabase takes its own automatic backups (frequency/retention depends on your plan — check your
project's **Database → Backups** page). For a manual backup of any Postgres database this project talks
to, `pg_dump` the connection string:

```bash
pg_dump "$DATABASE_URL" -f backup-$(date +%Y%m%d).sql
```

Restore with `psql "$DATABASE_URL" -f backup-20260101.sql` against a fresh/empty database (the app's own
migration runner will still apply cleanly on top — it's idempotent).

**Deletion**: `delete_activity` (with `confirm: true`) removes exactly one activity, its tag links, and
its search-index entry (the generated `search_vector` column updates itself); it leaves any decision/task
that referenced it in place, just detached (`activity_id` set to null). There is no bulk-delete tool by
design — if you need to wipe everything, truncate the tables yourself in the Supabase SQL editor or via
`psql`.

## Development

```bash
npm run dev            # stdio server, auto-restart on file change, runs TS directly
npm run dev:http       # REST ingestion API, same way (still requires CLAUDE_MEMORY_HTTP_ENABLED=true)
npm run dev:remote-mcp # remote MCP over HTTP, same way (still requires CLAUDE_MEMORY_REMOTE_MCP_ENABLED=true)
npm run typecheck     # tsc --noEmit
npm run lint          # eslint
npm run lint:fix
npm run format        # prettier --write
npm test              # vitest run (unit + integration + MCP-level, all in tests/)
npm run test:watch
npm run build         # tsc -> dist/
npm run check         # typecheck && lint && test && build, in that order
```

**Tests need a real reachable Postgres** — set `TEST_DATABASE_URL` (a dedicated database/project,
separate from whatever `DATABASE_URL` points at for real use, since every integration test truncates all
application tables between runs). The suite runs test files sequentially against one shared connection
pool (`fileParallelism: false` in `vitest.config.ts`) specifically so those truncates never race against
each other. The MCP-level tests (`tests/mcp/`) additionally connect a real `@modelcontextprotocol/client`
`Client` to a real `McpServer` over `InMemoryTransport.createLinkedPair()` — no subprocess, no stdio, but
a real protocol round-trip through real tool/resource/prompt registration, on top of the same shared
database.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `DATABASE_URL ... is not set` at startup | No connection string configured | Set `DATABASE_URL` in `.env` — see [Database: Supabase/Postgres setup](#database-supabasepostgres-setup) |
| Connection error / timeout on startup | Wrong password, wrong host, or Supabase project paused (free tier pauses after inactivity) | Double-check the connection string; wake the project from the Supabase dashboard if paused |
| `self-signed certificate` or similar TLS error | `CLAUDE_MEMORY_DB_SSL=strict` against a host whose cert chain Node doesn't trust | Use the default `require` (encrypts but doesn't verify the chain) unless you specifically need `strict` |
| Client can't connect / tools never appear | Wrong path in `.mcp.json`/CLI registration, or `dist/index.js` doesn't exist | Run `npm run build`; confirm the path is absolute and correct; check client logs |
| `CLAUDE_MEMORY_HTTP_ENABLED is true but ... TOKEN is not set` at startup | HTTP enabled with no token | Set `CLAUDE_MEMORY_HTTP_TOKEN` in `.env` |
| HTTP API: `401 UNAUTHORIZED` | Missing/wrong `Authorization: Bearer <token>` header | Check the header exactly matches `CLAUDE_MEMORY_HTTP_TOKEN` |
| HTTP API: CORS error in a browser | No origin on `CLAUDE_MEMORY_HTTP_CORS_ORIGINS`, or wrong origin | Add the exact origin (scheme+host+port) to the comma-separated list |
| `import_conversation` → "outside the configured import directories" | `CLAUDE_MEMORY_IMPORT_DIRS` is set and the path isn't inside it | Use a path inside an allowed directory, or unset the variable |
| `import_conversation` → "does not match the supported conversation import schema" | JSON isn't schemaVersion-1 shaped | Compare against `examples/sample-conversation.json` and `importedConversationV1Schema` in `src/domain/schemas.ts` |
| A tool call returns `isError: true` with a generic "unexpected internal error" message | An unhandled exception — intentionally generic so internals never leak to the client | Check the server's stderr log for the real error (structured JSON, one line per event) |
| Search returns no hits for text you can see is there | Usually a search term issue, not a bug — `websearch_to_tsquery` only matches whole words/token boundaries it indexed with | Try simpler/shorter search terms |
| Nothing ever gets saved even though "it should have" | The connected client never actually called `save_activity` | This is expected — see [`CLAUDE.md`](CLAUDE.md)'s opening warning; memory requires an explicit tool call, always |
| Remote MCP: every request gets `403` | Your tunnel's/deployment's hostname isn't on the Host-header allow-list | Add it to `CLAUDE_MEMORY_REMOTE_MCP_ALLOWED_HOSTS` and restart (see [ngrok](#testing-with-claudeai-web-via-a-tunnel-ngrok) or [Render](#deploying-to-render)) |
| Remote MCP: `401` from claude.ai even with the right token configured | claude.ai's custom-connector UI may send auth differently than expected (e.g. full OAuth instead of a bearer header) | Check exactly what header/flow claude.ai's current connector UI sends — this project only implements plain bearer-token auth for this entrypoint today |
| Render: first request after a while is very slow | Free tier spun the service down after inactivity | Expected — it wakes up in a few seconds; upgrade the plan if this matters for your use case |
| Tests fail immediately with `TEST_DATABASE_URL is not set` | No test database configured | Set `TEST_DATABASE_URL` to a real (ideally dedicated) Postgres connection string before running `npm test` |

## Known limitations

- **No live browser/Claude.ai-web capture.** Getting a web conversation into this store requires a human
  to export it and run `import_conversation` (or the HTTP ingest route) on that export. There is no
  component that reads browser profiles, cookies, local storage, or any undocumented private API — by
  design, not as an oversight.
- **Shared memory, not per-user private memory.** See [Multiple Claude profiles at
  once](#multiple-claude-profiles-at-once) — everyone with the bearer token reads/writes the same pool.
- **Remote MCP auth is a single shared bearer token, no OAuth.** Fine for personal/small-team use behind
  a token you control; not a substitute for a real per-user auth system.
- **No full-text ranking tuning.** Search uses Postgres's default `ts_rank` with no per-field weighting
  beyond the `setweight('A'/'B'/'C')` already applied to title/summary/content.
- **Project tagging schema exists, no tool uses it yet.** The `project_tags` table is in the schema (per
  the original spec's "support tags for projects and activities") but none of the 8 tools currently
  write to it — only activity tagging (`save_activity`'s `tags` field) is wired up.
- **No automatic secret scanning on import or save.** Nothing here detects or redacts credentials in
  content you save or import — that responsibility is on the caller (see `CLAUDE.md`).

## Roadmap

Things explicitly **not** built, with the seam they'd plug into:

- **A browser extension** that captures Claude.ai web conversations and pushes them to this server. It
  would be a separate, opt-in component with its own explicit permission model, talking to the existing
  `POST /api/v1/ingest/conversation` contract (optionally a per-message variant of
  `POST /api/v1/projects/:projectId/activities`) — it would not require changes to the memory engine
  itself, since ingestion is already adapter-based (`src/ingestion/adapters/`).
- **Per-user private memory.** Real per-profile auth (not one shared token) plus an owner/tenant column
  threaded through every table and every query, so different people/profiles get isolated data instead
  of one shared pool. A meaningfully larger feature than anything else in this README.
- **OAuth for the remote MCP entrypoint**, if claude.ai's custom-connector flow ends up requiring it
  instead of accepting a plain bearer token (see the caveat in
  [Testing with claude.ai web](#testing-with-claudeai-web-via-a-tunnel-ngrok)).

None of these exist today — don't represent any of them as available.
