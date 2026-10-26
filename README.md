# claude-activity-memory

An MCP (Model Context Protocol) server that gives Claude Code (or any MCP client) persistent, searchable
memory of project work — milestones, technical decisions, blockers, next steps — stored locally in
SQLite, available again in a brand-new session or a brand-new client.

**What this is not:** it does not watch a Claude.ai web browser session, and nothing in it runs
automatically just because it's installed. A connected client has to actually call its tools for
anything to be saved or retrieved. See [Known limitations](#known-limitations).

## Contents

- [Architecture](#architecture)
- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [Running the server](#running-the-server)
- [Claude Code integration](#claude-code-integration)
- [Verifying with the MCP Inspector](#verifying-with-the-mcp-inspector)
- [Using the tools](#using-the-tools)
- [Custom (user-saved) prompts and resources](#custom-user-saved-prompts-and-resources)
- [The optional HTTP ingestion API](#the-optional-http-ingestion-api)
- [Testing with claude.ai web via a tunnel (ngrok)](#testing-with-claudeai-web-via-a-tunnel-ngrok)
- [Database path and backups](#database-path-and-backups)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)
- [Roadmap: browser integration and a remote service](#roadmap-browser-integration-and-a-remote-service)

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
│ Remote MCP client        │◄──────►│  src/mcp-http/index.ts    │
│ (optional, e.g. claude.ai│        │  (McpServer, Streamable   │
│  web via ngrok)          │        │   HTTP, auth required)    │
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
                                         src/db/client.ts (node:sqlite)
                                         SQLite file + FTS5 index
```

Three independent, optional entrypoints share one `Container` (built in `src/container.ts`) and one
database: `src/index.ts` (stdio, what Claude Code spawns locally), `src/http/index.ts` (the bespoke REST
ingestion API), and `src/mcp-http/index.ts` (the *actual* MCP protocol over HTTP — for a remote client
like claude.ai web that can't spawn a local process). Starting any one of them never affects the others.

Layers, top to bottom:

- **MCP transport** (`src/mcp/`): registers 10 tools, 1 resource template, and 1 prompt on an `McpServer`
  from `@modelcontextprotocol/server` (the current stable v2 SDK line — see
  [`src/mcp/server.ts`](src/mcp/server.ts)), plus whatever prompts/resources have been saved at runtime via
  `save_prompt`/`save_resource` — see [Custom (user-saved) prompts and resources](#custom-user-saved-prompts-and-resources).
  Tool handlers call services; they never touch SQL directly.
- **Application services** (`src/services/`): the actual logic — dedup, fan-out from an activity into the
  decisions/tasks tables, search query building, import orchestration.
- **Domain** (`src/domain/`): TypeScript types and every Zod input schema, shared by the MCP tools and the
  HTTP routes so both surfaces validate identically.
- **Repositories** (`src/db/repositories/`): one file per table, parameterized SQL only.
- **Database** (`src/db/client.ts`, `src/db/migrations/`): a thin wrapper over Node's built-in
  `node:sqlite` with a transaction helper and an embedded migration runner.
- **Ingestion adapters** (`src/ingestion/adapters/`): turn raw JSON/Markdown/text into a normalized
  `{session, records[]}` shape that `ImportService` persists.
- **Optional HTTP API** (`src/http/`): a separate entrypoint (`src/http/index.ts`), never imported by the
  stdio entrypoint, so it can't interfere with the MCP stdio stream and stays fully optional.

### Why `node:sqlite` instead of `better-sqlite3`

This project uses Node's **built-in** `node:sqlite` module (stable without flags on Node ≥22.13/24.x)
rather than the `better-sqlite3` native dependency. It has full FTS5 support, which is all this project
needs, and it means one fewer native binding to install/prebuild across platforms. The trade-off: no
built-in `.transaction()` helper, so [`src/db/client.ts`](src/db/client.ts) hand-rolls one (with
reentrancy — a nested `transaction()` call joins its caller's transaction instead of trying to nest a
second `BEGIN`, which SQLite does not support).

### Why raw parameterized SQL instead of an ORM

The spec allowed either Drizzle ORM or parameterized SQL, whichever is simpler and more reliable.
Drizzle's SQLite FTS5 support is not first-class, and this schema is small (7 tables) — plain
parameterized SQL through `node:sqlite`'s `prepare()` keeps the whole data layer easy to read in one
pass and avoids fighting an ORM's virtual-table support. See `src/db/repositories/*.ts`.

### How `save_activity` populates decisions and tasks

There are 10 MCP tools, 8 of them fixed and no separate `create_decision` or `create_task` tool among
them. Instead,
`save_activity`'s `activityType` field drives it: `"decision"` also writes a row to the decisions table;
`"task"` or `"blocker"` also writes a row to the tasks table (`"blocker"` as status `blocked`). This is
documented for the connected client in [`CLAUDE.md`](CLAUDE.md) and in each tool's own description (so a
client reading `tools/list` sees it without reading this README).

## Requirements

- **Node.js ≥ 22.13.0** (LTS "Active" line; this was built and tested against Node 24.x). This is a hard
  requirement: `node:sqlite` needs ≥22.5, and runs without the `--experimental-sqlite` flag only from
  22.13+ (and unflagged on all of 23.4+/24.x). On Node 22.5–22.12 you'd need to add
  `--experimental-sqlite` to every `node` invocation below — upgrading is simpler.
- npm (ships with Node).
- No external services, no paid dependencies, no network calls from the stdio server.

Check your version:

```bash
node --version
```

## Installation

macOS/Linux:

```bash
git clone <this-repo-url> claude-activity-memory
cd claude-activity-memory
npm install
cp .env.example .env   # optional — defaults work with no .env at all
npm run build
```

Windows PowerShell:

```powershell
git clone <this-repo-url> claude-activity-memory
Set-Location claude-activity-memory
npm install
Copy-Item .env.example .env   # optional — defaults work with no .env at all
npm run build
```

## Configuration

All configuration is environment variables, read in [`src/config/env.ts`](src/config/env.ts) and loaded
from `.env` automatically via Node's native `--env-file-if-exists` flag (already wired into every
`npm run` script below — no `dotenv` dependency). See [`.env.example`](.env.example) for the full list
with defaults; the main ones:

| Variable | Default | Meaning |
|---|---|---|
| `CLAUDE_MEMORY_DB_PATH` | per-user data dir (below) | SQLite file path |
| `CLAUDE_MEMORY_MAX_RESULTS` | `50` | hard cap on rows returned by search/list tools |
| `CLAUDE_MEMORY_MAX_IMPORT_BYTES` | `5000000` | max accepted size for one import |
| `CLAUDE_MEMORY_MAX_IMPORT_RECORDS` | `2000` | max records one import may create |
| `CLAUDE_MEMORY_IMPORT_DIRS` | *(unset = unrestricted)* | comma-separated allowed directories for `import_conversation`'s `filePath` |
| `CLAUDE_MEMORY_HTTP_ENABLED` | `false` | must be `true` to let `npm run start:http` bind a port at all |
| `CLAUDE_MEMORY_HTTP_TOKEN` | *(none — required if HTTP is enabled)* | bearer token for the HTTP API |

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

1. Build the project (`npm run build`) so `dist/index.js` exists.
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

This opens a local web UI where you can call each of the 10 tools with example arguments, read the
`memory://projects/{projectName}/context` resource, and fetch the `resume_project` prompt — useful for
confirming the server behaves as documented before wiring it into a client.

There's also a non-interactive, scripted equivalent that this project ships and that was used to verify
the server end-to-end during development — see `scripts/verify-setup.ts`, next.

### Automated setup check

```bash
npm run build
npm run verify-setup
```

This spawns the real built server over stdio (the same way Claude Code does), confirms all 10 tools and
the prompt are registered, checks the FTS5 index's integrity, and round-trips one self-cleaning marker
activity through save → search → delete against **your actual configured database** — then removes the
marker. It leaves nothing behind either way (on failure, it still deletes the marker it created before
reporting the error). Exit code is non-zero on any failure.

## Using the tools

All 10 tools, their inputs, and their behavior are documented in their own descriptions (visible via
`tools/list` from any connected client) and in [`CLAUDE.md`](CLAUDE.md#while-working). Three concrete
walkthroughs:

### Save and search an activity

Via the Inspector or any connected client, call:

```jsonc
// save_activity
{
  "projectName": "My Project",
  "activityType": "decision",
  "title": "Use SQLite instead of Postgres",
  "summary": "Simplest option for a local-first, single-user tool; no server to run."
}
```

This creates the project (if new), the activity, and — because `activityType` is `"decision"` — a row in
the decisions table. Then:

```jsonc
// search_activity
{ "query": "SQLite" }
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

### Save a custom prompt or resource, then use it from a different session

```jsonc
// save_prompt
{ "name": "Daily Standup", "template": "Summarize what changed across all projects today." }
```

```jsonc
// save_resource
{ "name": "API Notes", "content": "Base URL: https://example.com\nAuth: bearer token in header." }
```

Both calls persist immediately (`name` is slugified into a stable identifier — `"Daily Standup"` becomes
`daily-standup`). Disconnect and reconnect with any client (or just open a second session) and call
`prompts/list` / `resources/list` — `daily-standup` and `memory://custom/api-notes` are now there
alongside the built-in `resume_project` prompt and `project-context` resource, with no code change or
restart required. See [Custom (user-saved) prompts and resources](#custom-user-saved-prompts-and-resources)
below for the full behavior.

### Retrieve project context in a new session

In a *different* session/client connected to the same database:

```jsonc
// get_project_context
{ "projectName": "DemoProject" }
```

returns the project's description/state/next-steps, its recent activities (summaries only — not full
message bodies, so this stays bounded), open/blocked tasks, and active decisions. For an unknown project
name this returns an error result rather than silently creating an empty project.

## Custom (user-saved) prompts and resources

The two built-in prompt/resource (`resume_project`, `project-context`) are registered in TypeScript at
build time. `save_prompt` and `save_resource` let a connected client define its *own* on top of that, at
runtime, backed by the `custom_prompts`/`custom_resources` tables — no code change or rebuild needed.

- **`save_prompt({ name, template, title?, description? })`** — `template` is returned verbatim as the
  single user-role message when the prompt is invoked. v1 is flat text only: no `{{placeholder}}`
  argument substitution (unlike the built-in `resume_project` prompt, which does take an argument).
- **`save_resource({ name, content, title?, description?, mimeType? })`** — becomes readable at
  `memory://custom/{name}` (`mimeType` defaults to `text/plain`).
- In both, `name` is slugified (lowercased, non-alphanumerics collapsed to `-`) into the stable,
  unique identifier — `"Daily Standup"` and `"daily standup"` are the same prompt. Saving again under a
  name that already exists **updates it in place** (same identifier, new content) rather than erroring or
  creating a duplicate.
- Global, not per-project — a saved prompt/resource is available regardless of which project you're
  working in, same as the two built-in ones.

**When does a saved one actually show up?** `createMcpServer()` — the one function that builds the tool/
resource/prompt set, shared by *every* entrypoint (stdio, remote HTTP) — loads every saved custom prompt
and resource from the database and registers it, every time a new session starts. So anything saved is
available the moment any client (the same one or a different one) next connects — including right away in
a brand-new session opened immediately after saving. It is **not** pushed live into a session that was
already open before the save happened; that session would need to reconnect to see it. (The one place
this doesn't apply: a single malformed saved row — e.g. somehow a name that collides with something else
— is logged and skipped rather than breaking registration for everything else in that session.)

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
future one would use (see [Roadmap](#roadmap-browser-integration-and-a-remote-service)).

## Testing with claude.ai web via a tunnel (ngrok)

Claude Code connects to this server by **spawning it locally** (stdio) — a browser can't do that.
claude.ai's web app instead needs a server reachable over **HTTPS**, speaking the actual MCP protocol
(not the REST API above). `src/mcp-http/index.ts` is that: a third, separate, also-optional entrypoint
that serves the exact same tools/resources/prompts over the MCP "Streamable HTTP" transport. This has
been tested end-to-end locally (real HTTP session, real auth, real tool calls — see
`tests/integration/remote-mcp-http.test.ts`); the ngrok + claude.ai steps below involve claude.ai's own
UI, which can change independently of this project, so verify the exact screen names yourself as you go.

### 1. Enable and start the remote MCP server

In `.env`:

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

## Database path and backups

Default database location (no `CLAUDE_MEMORY_DB_PATH` set):

- Windows: `%APPDATA%\claude-activity-memory\memory.db`
- macOS: `~/Library/Application Support/claude-activity-memory/memory.db`
- Linux: `$XDG_DATA_HOME/claude-activity-memory/memory.db` (falls back to `~/.local/share/...`)

It's a single SQLite database in **WAL mode**, so a running server will also have `memory.db-wal` and
`memory.db-shm` alongside it.

**Backup**: stop the server first (WAL files aren't guaranteed consistent to copy while a writer is
active), then copy all three files (`memory.db`, `memory.db-wal`, `memory.db-shm` — the latter two may
not exist if nothing was pending) as one set.

```bash
# macOS/Linux, server stopped:
cp memory.db memory.db-wal memory.db-shm /path/to/backup/ 2>/dev/null
```

```powershell
# Windows PowerShell, server stopped:
Copy-Item memory.db, memory.db-wal, memory.db-shm -Destination D:\backup\ -ErrorAction SilentlyContinue
```

**Restore**: stop the server, replace the file(s), start it again — the schema-migration check runs on
every startup and is a no-op if the restored file is already current.

**Deletion**: `delete_activity` (with `confirm: true`) removes exactly one activity, its tag links, and
its search-index entry; it leaves any decision/task that referenced it in place, just detached
(`activity_id` set to null). There is no bulk-delete tool by design — if you need to wipe everything,
stop the server and delete the database file(s) directly.

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

Tests (`tests/unit`, `tests/integration`, `tests/mcp`) never touch a real file or your real database —
unit/integration tests use an in-memory `node:sqlite` database per test (`tests/helpers.ts`), and the
MCP-level tests (`tests/mcp/`) connect a real `@modelcontextprotocol/client` `Client` to a real
`McpServer` over `InMemoryTransport.createLinkedPair()` — no subprocess, no stdio, but a real protocol
round-trip through real tool/resource/prompt registration.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Client can't connect / tools never appear | Wrong path in `.mcp.json`/CLI registration, or `dist/index.js` doesn't exist | Run `npm run build`; confirm the path is absolute and correct; check client logs |
| `CLAUDE_MEMORY_HTTP_ENABLED is true but ... TOKEN is not set` at startup | HTTP enabled with no token | Set `CLAUDE_MEMORY_HTTP_TOKEN` in `.env` |
| HTTP API: `401 UNAUTHORIZED` | Missing/wrong `Authorization: Bearer <token>` header | Check the header exactly matches `CLAUDE_MEMORY_HTTP_TOKEN` |
| HTTP API: CORS error in a browser | No origin on `CLAUDE_MEMORY_HTTP_CORS_ORIGINS`, or wrong origin | Add the exact origin (scheme+host+port) to the comma-separated list |
| `import_conversation` → "outside the configured import directories" | `CLAUDE_MEMORY_IMPORT_DIRS` is set and the path isn't inside it | Use a path inside an allowed directory, or unset the variable |
| `import_conversation` → "does not match the supported conversation import schema" | JSON isn't schemaVersion-1 shaped | Compare against `examples/sample-conversation.json` and `importedConversationV1Schema` in `src/domain/schemas.ts` |
| A tool call returns `isError: true` with a generic "unexpected internal error" message | An unhandled exception — intentionally generic so internals never leak to the client | Check the server's stderr log for the real error (structured JSON, one line per event) |
| `node:sqlite` import fails / `DatabaseSync is not a constructor` | Node version too old | Upgrade to Node ≥22.13 (22.5–22.12 needs `--experimental-sqlite`) |
| Search returns no hits for text you can see is there | Usually a search term issue, not a bug — FTS5 only matches token boundaries it indexed with (punctuation like `.`/`-`/`:` splits tokens) | Try simpler/shorter search terms; `search_activity` already quotes each word so operators like `AND`/`-foo` are treated as literal text, not FTS5 syntax |
| Nothing ever gets saved even though "it should have" | The connected client never actually called `save_activity` | This is expected — see [`CLAUDE.md`](CLAUDE.md)'s opening warning; memory requires an explicit tool call, always |
| Remote MCP: every tunneled request gets `403` | ngrok's hostname isn't on the Host-header allow-list | Add it to `CLAUDE_MEMORY_REMOTE_MCP_ALLOWED_HOSTS` and restart `start:remote-mcp` (see [Testing with claude.ai web](#testing-with-claudeai-web-via-a-tunnel-ngrok)) |
| Remote MCP: `401` from claude.ai even with the right token configured | claude.ai's custom-connector UI may send auth differently than expected (e.g. full OAuth instead of a bearer header) | Check exactly what header/flow claude.ai's current connector UI sends — this project only implements plain bearer-token auth for this entrypoint today |

## Known limitations

- **No live browser/Claude.ai-web capture.** Getting a web conversation into this store requires a human
  to export it and run `import_conversation` (or the HTTP ingest route) on that export. There is no
  component that reads browser profiles, cookies, local storage, or any undocumented private API — by
  design, not as an oversight.
- **Single-writer, single-machine.** SQLite in WAL mode handles one writer well; this is not a
  multi-user or multi-host memory store.
- **Remote MCP access is bearer-token-only, ngrok-tunnel-only.** `src/mcp-http/index.ts` lets a remote
  client reach this server, but there's no OAuth support, no persistent public hosting, and it's still
  the one local SQLite file underneath — see
  [Testing with claude.ai web](#testing-with-claudeai-web-via-a-tunnel-ngrok) and the
  [Roadmap](#roadmap-browser-integration-and-a-remote-service).
- **No full-text ranking tuning.** Search uses FTS5's default `bm25` ranking with no per-field weighting.
- **Project tagging schema exists, no tool uses it yet.** The `project_tags` table is in the schema (per
  the original spec's "support tags for projects and activities") but none of the 10 tools currently
  write to it — only activity tagging (`save_activity`'s `tags` field) is wired up.
- **No automatic secret scanning on import or save.** Nothing here detects or redacts credentials in
  content you save or import — that responsibility is on the caller (see `CLAUDE.md`).

## Roadmap: browser integration and a remote service

Two things explicitly **not** built in this milestone, by the original design brief, with the seam they'd
plug into:

- **A browser extension** that captures Claude.ai web conversations and pushes them to this server. It
  would be a separate, opt-in component with its own explicit permission model, talking to the existing
  `POST /api/v1/ingest/conversation` contract (optionally a per-message variant of
  `POST /api/v1/projects/:projectId/activities`) — it would not require changes to the memory engine
  itself, since ingestion is already adapter-based (`src/ingestion/adapters/`).
- **A permanently-hosted remote MCP service**, for memory shared across machines/people. The *transport*
  half of this now exists — `src/mcp-http/index.ts` serves the real MCP protocol over HTTP, and
  [Testing with claude.ai web via a tunnel](#testing-with-claudeai-web-via-a-tunnel-ngrok) covers
  connecting to it today via ngrok. What's still missing for a genuine always-on, multi-machine version:
  somewhere to host it that isn't your own laptop with a tunnel open, and — if it should be shared across
  machines rather than just reached remotely by one person — swapping the local SQLite file for a
  networked database behind the same repository interfaces, which is not done.

The browser extension does not exist today — don't represent it as available. The remote MCP transport
exists but is ngrok-tunnel-only, off by default, and still backed by one local SQLite file; don't
represent it as a hosted, always-on, or multi-machine-shared service.
