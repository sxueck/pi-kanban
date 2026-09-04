# pi-kanban

Cloud web kanban for [pi](https://github.com/earendil-works/pi-coding-agent) coding-agent sessions:

- **Remote approvals** — when a pi run hits a risky tool call and nobody is at
  the terminal (headless / AFK), it escalates to this dashboard for a decision.
- **Live progress** — running / waiting / idle / offline sessions with turn,
  message, tool-call, todo and cost telemetry.
- **Session history** — finished sessions grouped by git project.

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
- **Schema**: `projects / sessions / turns / messages / tool_calls /
  todo_lists+todos (append-only snapshots) / approvals`.

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
cp .env.example .env                    # set AGENT_TOKEN / ADMIN_TOKEN
pnpm db:push
pnpm dev:server                         # http://localhost:8787
pnpm dev:web                            # http://localhost:5173 (proxies /api)
```

Install the plugin on each machine running pi:

```bash
pnpm plugin:build && pnpm plugin:install
# then edit ~/.pi/agent/pi-kanban.json — see packages/pi-plugin/README.md
```

Env overrides for quick tests: `PI_KANBAN_URL`, `PI_KANBAN_TOKEN`.

If you use the local `workflow-guard` extension, remove it — both gates race
and workflow-guard hard-blocks headless runs before this plugin can escalate.

## Verify

```bash
# server + db running, then:
node scripts/e2e-smoke.mjs   # full protocol round-trip incl. cloud approval
```

The smoke script assumes `AGENT_TOKEN=t ADMIN_TOKEN=a`; it leaves its data in
the dev database.
