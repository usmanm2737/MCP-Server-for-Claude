# Connecting this server to claude.ai web — session notes and guide

This documents what was actually discovered and run while testing `src/mcp-http/index.ts` (the
remote MCP / Streamable HTTP entrypoint) against claude.ai's web **custom connector** feature via an
ngrok tunnel. It supplements — does not replace — the main
[README "Testing with claude.ai web via a tunnel (ngrok)"](../README.md#testing-with-claudeai-web-via-a-tunnel-ngrok)
section.

## What we learned that the README didn't know yet

As of testing on **2026-10-24**, on this claude.ai account, the "Add custom connector" dialog only
offers:

- **Sign in now** / **Sign in when needed** — full OAuth 2.1. Claude.ai auto-detects this is
  "required" the moment your server returns `401` to an unauthenticated request (which this server
  always does by design).
- **No sign-in** — sends **zero** credentials on every request. There is **no field anywhere in this
  dialog (creation or edit) for a static header, API key, or bearer token**, despite Anthropic's own
  help-center article describing one under "Request headers." That capability may only exist in a
  Team/Enterprise workspace's admin-level connector settings, or may have been removed/relocated since
  that article was written — either way, it is not reachable from this personal account's UI.

**Net effect:** today, with this server's real (token-based) auth switched on, claude.ai web cannot
connect at all — not because of a bug, but because there is no UI path to supply the token. The only
way to get claude.ai web connected right now is the temporary bypass below, until real OAuth is built
(see [Removing this limitation](#removing-this-limitation-build-real-oauth)).

## Normal (secure) run — for any MCP client that *does* support a bearer header

Use this for the MCP Inspector, scripts, or any future OAuth-capable setup. Full steps are in the
[README](../README.md#testing-with-claudeai-web-via-a-tunnel-ngrok); summary:

```bash
# .env: CLAUDE_MEMORY_REMOTE_MCP_ENABLED=true, CLAUDE_MEMORY_REMOTE_MCP_TOKEN=<token>
npm run build
npm run start:remote-mcp
ngrok http 8789
# copy the printed hostname into CLAUDE_MEMORY_REMOTE_MCP_ALLOWED_HOSTS in .env, then restart
```

Verify before trusting it:

```bash
curl -X POST https://<ngrok-host>/mcp -d '{}'          # expect 401
curl -X POST https://<ngrok-host>/mcp -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"check","version":"1.0"}}}'
# expect a real result with protocolVersion/capabilities/serverInfo
```

## The no-sign-in bypass workflow (what actually connects to claude.ai web today)

**This intentionally disables authentication.** While it's on, the public ngrok URL accepts requests
from **anyone who has it** — not just you — with full access to every tool, including
`delete_activity` and `update_project_state`. Treat it as "the front door is open," not "locked with
a hard-to-guess key." Only run it for as long as you're actively testing, and lock it back down
(last section) the moment you're done.

### 1–2. Build and start the base server, same as above

`.env` must still have `CLAUDE_MEMORY_REMOTE_MCP_ENABLED=true` and
`CLAUDE_MEMORY_REMOTE_MCP_TOKEN=<token>` set — the server still refuses to start at all without a
token configured. The bypass flag below only skips *checking* it per-request; it doesn't remove the
startup requirement.

```bash
npm run build
```

### 3. Start the tunnel, allow its hostname

```bash
ngrok http 8789
```

Copy the printed `https://<something>.ngrok-free.dev` (or `.ngrok-free.app`) hostname into
`CLAUDE_MEMORY_REMOTE_MCP_ALLOWED_HOSTS` in `.env` (comma-separated if you ever need more than one).
**Free ngrok hostnames change every time the tunnel restarts** — redo this step each session unless
you're on a paid ngrok plan with a reserved domain.

### 4. Start the server **with the bypass flag, passed inline — never saved to `.env`**

Git Bash / macOS / Linux:

```bash
CLAUDE_MEMORY_REMOTE_MCP_DISABLE_AUTH_DANGEROUSLY=true node --env-file-if-exists=.env dist/mcp-http/index.js
```

Windows PowerShell:

```powershell
$env:CLAUDE_MEMORY_REMOTE_MCP_DISABLE_AUTH_DANGEROUSLY = "true"
node --env-file-if-exists=.env dist/mcp-http/index.js
```

You must see this line in the startup log — if you don't, the bypass isn't active and claude.ai still
won't be able to connect:

```
"*** CLAUDE_MEMORY_REMOTE_MCP_DISABLE_AUTH_DANGEROUSLY=true — every request to /mcp is being
accepted WITHOUT checking the bearer token. ... ***"
```

Sanity-check it from the outside before touching claude.ai:

```bash
curl -X POST https://<ngrok-host>/mcp -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"check","version":"1.0"}}}'
```

A real `result` with no `Authorization` header sent means the bypass is working.

### 5. Add the connector in claude.ai web

**Settings → Connectors → Add custom connector** (label may have moved — look for "connectors,"
"integrations," or "custom MCP server"):

- **URL:** `https://<ngrok-host>/mcp`
- **Authentication:** **No sign-in**. Claude will show a warning ("this server requires sign-in...
  will likely fail") — that's just its detection heuristic reacting to the 401 an unauthenticated
  probe normally gets; it doesn't apply once the bypass is on. Click **Add anyway**.
- **Advanced → Transport:** leave on **Streamable HTTP** (auto-detected from the URL).

Confirm Claude can see all 8 tools and run one safe read-only call (e.g. ask it to list recent
activity) before trusting it further.

### 6. Lock it back down the moment you're done

This is not optional cleanup — do it every time, immediately after testing:

```bash
# find the PID actually running dist/mcp-http/index.js and stop it (not just Ctrl+C if
# backgrounded — on Windows in particular, confirm via the real process list, not a shell job id)
```

PowerShell:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*mcp-http*' } |
  Select-Object ProcessId, CommandLine
Stop-Process -Id <that ProcessId> -Force
```

Then restart **without** the flag:

```bash
node --env-file-if-exists=.env dist/mcp-http/index.js
```

Verify auth is back on:

```bash
curl -X POST https://<ngrok-host>/mcp -d '{}'   # must be 401 again
```

Then stop the tunnel (`ngrok http` process) and the server itself if you're not continuing to use
them. The claude.ai connector will show "Connection issue" again once auth is back on — that's
expected; it's still configured for "No sign-in" and has no credential to offer.

## Removing this limitation: build real OAuth

The durable fix — so claude.ai web (any account, any session) can connect through **"Sign in now"**
without ever disabling auth — is implementing OAuth 2.1 on this server: an authorization endpoint, a
token endpoint, PKCE, dynamic client registration (so Claude can register itself automatically), and
the `/.well-known/oauth-authorization-server` / `/.well-known/oauth-protected-resource` metadata
routes the MCP authorization spec expects. Not done in this milestone — flagged here as the next step
if recurring claude.ai web access becomes a real need rather than one-off testing.
