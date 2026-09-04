import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	ApprovalLocalResolutionMessage,
	ApprovalRequestMessage,
	GateConfig,
	GateRule,
	UpstreamMessage,
} from "@pi-kanban/shared";
import type { DecisionVerdict } from "./transport.js";

interface ToolCallEvent {
	toolName: string;
	toolCallId: string;
	input: unknown;
}

export function matchRule(
	rules: GateRule[],
	toolName: string,
	input: unknown,
): GateRule | null {
	let serialized: string;
	try {
		serialized = JSON.stringify(input) ?? "";
	} catch {
		serialized = String(input);
	}
	for (const rule of rules) {
		if (rule.tool && rule.tool !== toolName) continue;
		if (!rule.match) return rule;
		try {
			if (new RegExp(rule.match, rule.flags ?? "i").test(serialized)) return rule;
		} catch {
		// Ignore malformed user config.
		}
	}
	return null;
}

function sleep(ms: number): Promise<"timeout"> {
	return new Promise((resolve) => setTimeout(() => resolve("timeout"), ms));
}

export type GateVerdict = "approved" | "denied" | "timeout" | "offline";

export interface GateTransport {
	readonly connected: boolean;
	send(msg: UpstreamMessage): void;
	requestApproval(
		msg: Omit<ApprovalRequestMessage, "requestId">,
		timeoutMs?: number,
	): Promise<string | null>;
	waitForDecision(approvalId: string, onDecision: (verdict: DecisionVerdict) => void): () => void;
}

export interface GateDeps {
	gate: GateConfig;
	transport: GateTransport;
	getSessionId(): string | null;
	getTurnPosition(): number | undefined;
}

/**
 * Local-first, cloud-fallback permission gate:
 * 1. TUI present -> ask locally first (ctx.ui.confirm), bounded by localTimeoutSec.
 * 2. Headless, or local prompt unanswered -> escalate to the cloud kanban
 *    (bounded by cloudTimeoutSec).
 * 3. Neither answers -> onTimeout policy ("deny" default).
 * Local answers always reach the cloud as an audit trail.
 *
 * Offline rule: whenever the server is unreachable (before the call or the
 * connection drops mid-flight), the plugin stands down entirely — no prompt,
 * no cloud request, no block — as if it were not installed. Only a
 * connected-but-silent server can fall through to onTimeout.
 */
export async function runGate(
	deps: GateDeps,
	event: ToolCallEvent,
	ctx: ExtensionContext,
): Promise<{ block: boolean; reason?: string } | undefined> {
	const rule = matchRule(deps.gate.rules, event.toolName, event.input);
	if (!rule) return undefined;
	if (!deps.transport.connected) return undefined;

	const sessionId = deps.getSessionId();
	const base = {
		type: "approval_request" as const,
		sessionId: sessionId ?? "ephemeral",
		toolCallId: event.toolCallId,
		toolName: event.toolName,
		input: event.input,
		policyLabel: rule.label,
		createdAt: Date.now(),
	};

	const cloudWait = (): Promise<GateVerdict> =>
		waitForCloud(deps, { ...base, localPrompted: ctx.hasUI });

	let localPrompt: Promise<boolean> | null = null;
	if (ctx.hasUI && deps.gate.localTimeoutSec > 0) {
		localPrompt = ctx.ui.confirm(
			"pi-kanban approval",
			`Allow ${rule.label}?\n\n${summarizeInput(event)}`,
		);
		const local = await Promise.race([
			localPrompt,
			sleep(deps.gate.localTimeoutSec * 1000),
		]);
		if (local !== "timeout") {
			void auditLocalResolution(deps, { ...base, localPrompted: true }, local === true);
			return local ? undefined : { block: true, reason: `Denied locally: ${rule.label}` };
		}
		// Unanswered locally — keep the dialog open, escalate to cloud below;
		// whichever side answers first wins.
	}

	if (!ctx.hasUI && !deps.gate.escalateWhenHeadless) {
		return {
			block: true,
			reason: `Blocked ${rule.label}: no local UI and cloud escalation disabled`,
		};
	}

	const decision = await Promise.race(
		localPrompt
			? [
					cloudWait(),
				localPrompt.then((ok) => (ok ? ("approved" as const) : ("denied" as const))),
			]
			: [cloudWait()],
	);

	if (decision === "offline") return undefined;
	if (decision === "approved") return undefined;
	if (decision === "denied") {
		return { block: true, reason: `Denied (${rule.label})` };
	}
	return deps.gate.onTimeout === "deny"
		? {
				block: true,
				reason: `pi-kanban: no approval within ${deps.gate.cloudTimeoutSec}s for ${rule.label}; denied by policy`,
			}
		: undefined;
}

async function waitForCloud(
	deps: GateDeps,
	request: Omit<ApprovalRequestMessage, "requestId">,
): Promise<GateVerdict> {
	if (!deps.transport.connected) return "offline";
	const approvalId = await deps.transport.requestApproval(request);
	// A missing ack means "offline" when the connection died around the
	// request; only a live-but-silent server counts as a timeout.
	if (!approvalId) return deps.transport.connected ? "timeout" : "offline";
	return new Promise<GateVerdict>((resolve) => {
		const finish = (verdict: DecisionVerdict) => {
			unlisten();
			clearTimeout(timer);
			resolve(verdict);
		};
		const timer = setTimeout(
			() => {
				unlisten();
				resolve("timeout");
			},
			deps.gate.cloudTimeoutSec * 1000,
		);
		const unlisten = deps.transport.waitForDecision(approvalId, finish);
	});
}

async function auditLocalResolution(
	deps: GateDeps,
	request: Omit<ApprovalRequestMessage, "requestId">,
	approved: boolean,
): Promise<void> {
	const approvalId = await deps.transport.requestApproval(request);
	if (!approvalId) return;
	const resolution: ApprovalLocalResolutionMessage = {
		type: "approval_local_resolution",
		approvalId,
		sessionId: request.sessionId,
		decision: approved ? "approved" : "denied",
		note: "answered at local TUI",
	};
	deps.transport.send(resolution);
}

function summarizeInput(event: ToolCallEvent): string {
	try {
		const raw = JSON.stringify(event.input, null, 2) ?? "";
		return raw.length > 1500 ? `${raw.slice(0, 1500)}…` : raw;
	} catch {
		return String(event.input);
	}
}
