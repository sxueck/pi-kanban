# @pi-kanban/plugin

pi extension that streams session lifecycle to a pi-kanban server and gates
risky tool calls with **local-first, cloud-fallback** approval.

## Install

```bash
pnpm plugin:build && pnpm plugin:install   # copies dist/pi-kanban.ts to ~/.pi/agent/extensions/
```

Then create `~/.pi/agent/pi-kanban.json`:

```json
{
	"server": {
		"url": "ws://your-server:8787/agent",
		"agentToken": "<AGENT_TOKEN of the server>"
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

Env overrides for quick tests: `PI_KANBAN_URL`, `PI_KANBAN_TOKEN`.

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
- **Heartbeat**: every 30s while connected; the server marks a session `offline`
  after 90s of silence.
- Transport is offline-tolerant: queued outbox (500 msgs), exponential reconnect;
  pending approval waits are released (allowed) on disconnect.

If you use the local `workflow-guard` extension, remove it — both gates would
race and workflow-guard blocks headless runs before this plugin can escalate.
