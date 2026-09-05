# pi-kanban

Cloud web kanban for [pi](https://github.com/earendil-works/pi-coding-agent) coding-agent sessions:

- **Remote approvals** — when a pi run hits a risky tool call and nobody is at
  the terminal (headless / AFK), it escalates to this dashboard for a decision.
- **Live progress** — running / waiting / idle / offline sessions with turn,
  message, tool-call, todo and cost telemetry.
- **Session history** — finished sessions grouped by git project.
- **Multi-user isolation** — local username/password accounts, per-user Agent Tokens, and private session, approval, and history views.

A pi **extension** is injected locally and pushes the session stream upstream
(when the server is unreachable, the plugin stands down entirely — see the
  gate notes below).

## Architecture

```
pi extension (packages/pi-plugin)                apps/server                    apps/web
─────────────────────────────                ─────────────────              ─────────
session_start/end ──┐
turn_start/end      │ WebSocket        ingest → Postgres (drizzle)
message_end (+cost) ├────────────────▶  approvals ──▶ WS push ──┐      Board / Approvals /
tool_execution_*    │  /agent           REST /api/*             ├──◀── SSE  History / Detail
tool_call ─(gate)───┤                   SSE /api/events         │      (Vite React SPA)
heartbeat 30s       │◀─ approval_decision ───────────────────────┘
(HTTP + WS)         │
```

- **Gate** (`tool_call`, blockable): local-first — TUI `ctx.ui.confirm` up to
  `localTimeoutSec`; if unanswered or headless (`-p`/json mode), escalate to the
  cloud; `cloudTimeoutSec` with `onTimeout` fallback (default deny). Local
  answers are reported back as an audit trail.
- **Offline = inert**: while the server is unreachable the plugin does nothing
  at all — no prompts, no blocks, no cloud requests — as if it were not
  installed. Only a connected-but-silent server can fall through to
  `onTimeout`.
- **State derivation** (server): pending approval > open turn > idle; heartbeat
  silence (90s) → offline; `session_shutdown` → finished.
- **Schema**: `users / web_sessions / agent_tokens / projects / sessions / turns /
  messages / tool_calls / todo_lists+todos (append-only snapshots) / approvals`.
- **Ownership**: each user creates an Agent Token in the dashboard and exports it
  as `PI_KANBAN_TOKEN` on their own pi machines. Every reported session is then
  bound to that user.

## Layout

- `packages/shared` — WebSocket protocol, REST DTOs, plugin config types.
- `packages/pi-plugin` — the pi extension; bundles to a single dependency-free
  `pi-kanban.ts`.
- `apps/server` — Hono + ws + Postgres (drizzle-orm).
- `apps/web` — React SPA.

## Quick start

```bash
pnpm install
docker compose up -d db                 # postgres:17
cp .env.example .env                    # set a strong ADMIN_TOKEN
pnpm db:push
pnpm dev:server                         # http://localhost:8787
pnpm dev:web                            # http://localhost:5173 (proxies /api)
```

Open the dashboard and create the first administrator account with `ADMIN_TOKEN`.
The administrator creates other users from **Account**. Each user then creates a
machine Agent Token from **Account** before installing the plugin on their own
machine.

Install the plugin on each machine running pi:

```bash
pnpm plugin:build && pnpm plugin:install
# then edit ~/.pi/agent/pi-kanban.json — see packages/pi-plugin/README.md
```

`PI_KANBAN_TOKEN` is the per-user machine Agent Token, read from the
environment (e.g. exported in `~/.zshrc`) — it is never stored in the plugin
config file. `PI_KANBAN_URL` remains available as an environment override.

## Migrating an existing database

The multi-user migration intentionally deletes existing session history because
those rows have no trustworthy owner. Back up anything you need first, then run:

```bash
psql "$DATABASE_URL" -f apps/server/drizzle/0000_multi_user.sql
pnpm db:push
```

New installations only need `pnpm db:push`.

If you use the local `workflow-guard` extension, remove it — both gates race
and workflow-guard hard-blocks headless runs before this plugin can escalate.
