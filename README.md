# pi-kanban

Cloud web kanban for [pi](https://github.com/earendil-works/pi-coding-agent) coding-agent sessions:

- **Remote approvals** — when a pi run hits a risky tool call and nobody is at
  the terminal (headless / AFK), it escalates to this dashboard for a decision.
- **Live progress** — running / waiting / idle / offline sessions with turn,
  message, tool-call, todo and cost telemetry.
- **Session history** — finished sessions grouped by git project.
- **Project memory** — PII-redacted model inspections produce reviewable, versioned memories plus a project structure and issue tree. Confirmed memories and recurring findings are pushed back to the plugin (`memory_fetch` on session start, a digest push after each inspection) and injected as a bounded advisory block into future session prompts, closing the loop.
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
project_snapshot     │  /agent           inspect → memories/tree ├──◀── SSE  History / Detail
tool_execution_*    │  /agent           REST /api/*             ├──◀── SSE  History / Detail
tool_call ─(gate)───┤                   SSE /api/events         │      (Vite React SPA)
heartbeat 30s       │◀─ approval_decision ───────────────────────┘
(HTTP + WS)         │◀─ memory_digest (post-inspection push → system prompt)
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
- **Project inspection**: the plugin uploads a bounded relative-path manifest, Git summary, and `git diff --check` findings, never source contents. Immediately before each model request, the server heuristically redacts common PII and secret formats and rechecks model output before persistence. Regex redaction cannot identify every free-form name or address, so use a provider appropriate for the project's data sensitivity.
- **Inspection budgets and timeouts** (nothing is retried automatically): an inspection is split into at most four sequential session batches (three sessions per batch). Each model request may spend up to 10 minutes (Settings connection test: 30s), and the project claim remains live for 50 minutes so a slow batch sequence is not reclaimed. Timeouts — including a stalled response body — are reported as actionable errors on the run/inspection. Input is deterministically capped at ~400KB serialized per batch (12 sessions are partitioned, up to 400 messages and 100 failed tool calls are assigned to their session batch, and 200 known memories plus a 250-node structure tree are repeated); items that no longer fit are dropped whole and reported to the model via `context.omitted`, and serialized JSON is never cut mid-string. Output is capped at 1MB / 400k chars / 20 memories / 300 tree nodes per batch, then memories are deduplicated and tree insight ids are made unique before one project result is persisted.
- **Inspection scheduling**: cron-like — a weekday set plus a daily time window (server time zone) with a fixed interval inside it (e.g. Mon–Fri 09:00–18:00 every 30 min, slots aligned to the window start). Enabling inspections or changing the schedule reschedules idle projects to the schedule's next slot, and disabling stops future scheduled runs without clearing a live lock — an in-flight inspection finishes and releases its own claim. Failed runs reschedule at the next slot (not the 10-minute lock TTL), and manual inspection works even while the scheduler is disabled.
- **Schema**: `users / web_sessions / agent_tokens / projects / sessions / turns /
  messages / tool_calls / todo_lists+todos / approvals / project_snapshots /
  project_analysis_states / project_inspections / project_memories / model_settings`.
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
cp .env.example .env                    # set ADMIN_TOKEN and MODEL_SETTINGS_SECRET
pnpm db:push
pnpm dev:server                         # http://localhost:8787
pnpm dev:web                            # http://localhost:5173 (proxies /api)
```

Open the dashboard and create the first administrator account with `ADMIN_TOKEN`.
The administrator creates other users from **Account**. Each user then creates a
machine Agent Token from **Account** before installing the plugin on their own
machine.

## Docker deployment

`ghcr.io/sxueck/pi-kanban` (built by `.github/workflows/docker.yml` on every
push to `main` and `v*` tag) serves the dashboard, API, and agent WebSocket
from one port:

```bash
cp .env.example .env        # set ADMIN_TOKEN and MODEL_SETTINGS_SECRET
docker compose up -d        # db + kanban on http://localhost:8787
```

Install the plugin on each machine running pi:

```bash
pnpm plugin:build && pnpm plugin:install
# then edit ~/.pi/agent/pi-kanban.json — see packages/pi-plugin/README.md
```

`PI_KANBAN_TOKEN` is the per-user machine Agent Token, read from the
environment (e.g. exported in `~/.zshrc`) — it is never stored in the plugin
config file. `PI_KANBAN_URL` overrides the plugin's upload target (a base URL
like `https://kanban.example.com` is enough; see
`packages/pi-plugin/README.md`).

## Migrating an existing database

At startup the server applies `apps/server/drizzle/*.sql` in filename order,
tracked in a `_migrations` ledger (files are generated with `drizzle-kit
generate`; regenerate instead of hand-editing after `schema.ts` changes). A
database previously created with `pnpm db:push` is detected via its existing
tables and baselined without replaying — `pnpm db:push` keeps working for dev.

Full model inspections run as at most four sequential three-session batches, each with a 10-minute request budget; the project claim TTL is 50 minutes so a legitimate slow sequence is not reclaimed. Connection tests use 30 seconds. Requests are not automatically retried. Inspection input is bounded to 400 KB per batch before redaction, using whole records and a structure tree rather than the raw file manifest; omission counts describe records removed by that byte budget (database queries also have row caps). Generation is capped at 8,192 tokens per batch and requests up to 40 concise insights. Batch results are merged into one run, with duplicate memories removed and unique tree insight ids. A failed scheduled inspection becomes due again after the configured interval. Saving unchanged settings does not restart every project, and disabling the scheduler does not cancel or unlock an in-flight inspection.

Focused UI regression check: `cd apps/web && node test/run-project-memory.mjs`.

`MODEL_SETTINGS_SECRET` encrypts the global model API key at rest. Keep it stable; changing it makes the saved key unreadable and requires entering the key again in **Settings**.

If you use the local `workflow-guard` extension, remove it — both gates race
and workflow-guard hard-blocks headless runs before this plugin can escalate.
