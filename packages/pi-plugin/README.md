# @pi-kanban/plugin

pi extension that streams session lifecycle to a pi-kanban server and gates
risky tool calls with **local-first, cloud-fallback** approval.

## Install

```bash
pnpm plugin:build && pnpm plugin:install   # copies dist/pi-kanban.ts to ~/.pi/agent/extensions/
```

Then set the machine Agent Token as an environment variable (it is no longer
read from the config file) and create `~/.pi/agent/pi-kanban.json`:

```sh
# ~/.zshrc / ~/.bashrc — token stays out of dotfiles that other tools may read
export PI_KANBAN_TOKEN="<your machine Agent Token from the dashboard Account page>"
```

```json
{
	"server": {
		"url": "ws://your-server:8787/agent"
	},
	"gate": {
		"rules": [
			{ "tool": "bash", "match": "\\bgit\\s+push\\b", "flags": "i", "label": "git push" },
			{ "tool": "bash", "match": "rm\\s+-[a-z]*r", "flags": "i", "label": "recursive rm" }
		],
		"localTimeoutSec": 30,
		"cloudTimeoutSec": 300,
		"onTimeout": "deny",
		"escalateWhenHeadless": true
	},
	"report": {
		"excerptChars": 2000,
		"reportToolInputs": true
	}
}
```

Each pi user must create their own Agent Token in the dashboard **Account** page
and export it as `PI_KANBAN_TOKEN` on their own machines. That token binds
reported sessions to the user; it replaces the old server-wide `AGENT_TOKEN`.

`PI_KANBAN_URL` is the environment override for the server URL — it wins over
`server.url` in the config file. A base URL is enough: `http(s)://` is upgraded
to `ws(s)://` and a missing path gets the `/agent` endpoint appended, so all of
`https://kanban.example.com`, `kanban.example.com:8787`, and
`wss://kanban.example.com/agent` point at the same upload target (an explicit
path such as `/kanban/agent` behind a reverse proxy is kept as-is).

## Behavior

- **Offline = inert**: unless the WebSocket to the server is up, the plugin does
  nothing — no prompts, no blocks, no cloud requests — as if it were not
  installed. Session events still queue in the bounded outbox and flush on
  reconnect; heartbeats are skipped while offline (they are only meaningful
  live). A disconnect during a pending approval releases it as "offline"
  (allowed).
- **Approval gate** (`tool_call`, blockable): when a rule matches,
  1. with a TUI attached, ask locally first (`ctx.ui.confirm`), up to `localTimeoutSec`;
  2. if unanswered or headless (`json`/`-p` modes), escalate to the cloud kanban;
  3. first answer wins; nobody answers within `cloudTimeoutSec` -> `onTimeout` policy.
  Local answers are reported to the cloud as an audit trail.
- **Session stream**: `session_start` / `turn_start` / `message_end` /
  `tool_execution_start|end` / `turn_end` (with todo snapshot from the session's
  `todo` extension entries) / `session_shutdown` -> WebSocket upstream.
- **Heartbeat**: every 30s the plugin POSTs `/agent/heartbeat` (Bearer token,
  same payload as the WS heartbeat) — sessions stay alive even while the
  WebSocket is down. The WS heartbeat doubles as a liveness probe: the server
  acks it, and a connection with no inbound traffic for 90s is force-reconnected
  (recovers half-open sockets after sleep/NAT changes instead of waiting for a
  TCP timeout). The server also pings WS clients and reaps dead ones within
  ~60s; the dashboard marks a session `offline` after 90s of total heartbeat
  silence.
- **Project memory injection** (inspection → runtime loop): at `session_start`
  the plugin sends `memory_fetch`; the server replies with a `memory_digest` —
  the project's confirmed/pinned memories and recurring findings, server-side
  redacted before persistence, capped at 24 + 8 items / 8 KB. The block is
  appended to each turn's system prompt (≤ 4 KB, advisory wording). Digests
  are cached at `~/.pi/agent/pi-kanban-memories.json` (7-day TTL) so injection
  also works offline or across restarts; pushes after each successful
  inspection refresh live sessions without waiting for the next session.
- **`/kanban-status`**: prints a metrics snapshot into the transcript (display
  only, never sent to the LLM) — connection state and outbox backlog, per-turn
  injection counts, the active digest (revision, age, injected memory/finding
  breakdown), injection block size vs budget, and every cached project digest.
- Transport is offline-tolerant: queued outbox (500 msgs), exponential reconnect;
  pending approval waits are released (allowed) on disconnect.

If you use the local `workflow-guard` extension, remove it — both gates would
race and workflow-guard blocks headless runs before this plugin can escalate.
