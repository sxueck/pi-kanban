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

/**
 * A command string the input will actually execute, with the tool scope its
 * rules govern. `then_run` is the SoL-Pi Action Fusion field: an edit/write
 * may carry a bash command executed inside the same tool call, so it never
 * surfaces as a bash tool_call — those fused commands must still face bash
 * rules (see github.com/NVlabs/SoL-Pi).
 */
interface CommandCarrier {
	command: string;
	/** Tool whose rule scope this command executes under. */
	scope: string;
}

function commandCarriers(toolName: string, input: unknown): CommandCarrier[] {
	if (typeof input !== "object" || input === null) return [];
	const record = input as Record<string, unknown>;
	if (toolName === "bash" || toolName === "powershell") {
		return typeof record.command === "string" ? [{ command: record.command, scope: toolName }] : [];
	}
	if (toolName === "edit" || toolName === "write") {
		const thenRun = record.then_run;
		if (
			typeof thenRun === "object" &&
			thenRun !== null &&
			typeof (thenRun as Record<string, unknown>).command === "string"
		) {
			// SoL-Pi executes then_run through its bash tool definition, so the
			// fused command always runs in a bash scope regardless of carrier.
			return [
				{ command: (thenRun as { command: string }).command, scope: "bash" },
			];
		}
		return [];
	}
	return [];
}

export function matchRule(
	rules: GateRule[],
	toolName: string,
	input: unknown,
): GateRule | null {
	const carriers = commandCarriers(toolName, input);
	let serialized: string | undefined;
	const inputJson = (): string => {
		if (serialized === undefined) {
			try {
				serialized = JSON.stringify(input) ?? "";
			} catch {
				serialized = String(input);
			}
		}
		return serialized;
	};
	for (const rule of rules) {
		if (!rule.match) return rule;
		let regex: RegExp;
		try {
			regex = new RegExp(rule.match, rule.flags ?? "i");
		} catch {
			// An invalid approval regex must not silently remove its gate.
			return rule;
		}
		if (rule.tool) {
			// Scoped rules see only the command text they govern — never edit
			// payloads — so a dangerous string in file contents cannot trip a
			// bash rule.
			if (carriers.some((carrier) => carrier.scope === rule.tool && regex.test(carrier.command))) {
				return rule;
			}
			continue;
		}
		if (regex.test(inputJson())) return rule;
	}
	return null;
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

	// Cancels the local confirm dialog once the gate resolves by any path
	// (local answer, cloud decision, timeout) and when the turn aborts.
	const dialogAbort = new AbortController();
	const onCtxAbort = () => dialogAbort.abort();
	if (ctx.signal) {
		if (ctx.signal.aborted) dialogAbort.abort();
		else ctx.signal.addEventListener("abort", onCtxAbort, { once: true });
	}
	const cloudWait = (): Promise<GateVerdict> =>
		waitForCloud(deps, { ...base, localPrompted: ctx.hasUI }, dialogAbort.signal);

	let localPrompt: Promise<boolean> | null = null;
	let localTimer: ReturnType<typeof setTimeout> | undefined;
	try {
		if (ctx.hasUI && deps.gate.localTimeoutSec > 0) {
			localPrompt = ctx.ui.confirm(
				"pi-kanban approval",
				`Allow ${rule.label}?\n\n${summarizeInput(event)}`,
				{ signal: dialogAbort.signal },
			);
			const local = await Promise.race([
				localPrompt,
				new Promise((resolve: (v: "timeout") => void) => {
					localTimer = setTimeout(() => resolve("timeout"), deps.gate.localTimeoutSec * 1000);
				}),
			]);
			if (local !== "timeout") {
				void auditLocalResolution(deps, { ...base, localPrompted: true }, local === true);
				return local ? undefined : { block: true, reason: `Denied locally: ${rule.label}` };
			}
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
	} finally {
		clearTimeout(localTimer);
		ctx.signal?.removeEventListener("abort", onCtxAbort);
		dialogAbort.abort();
	}
}

async function waitForCloud(
	deps: GateDeps,
	request: Omit<ApprovalRequestMessage, "requestId">,
	signal?: AbortSignal,
): Promise<GateVerdict> {
	if (!deps.transport.connected) return "offline";
	const approvalId = await deps.transport.requestApproval(request);
	// A missing ack means "offline" when the connection died around the
	// request; only a live-but-silent server counts as a timeout.
	if (!approvalId) return deps.transport.connected ? "timeout" : "offline";
	return new Promise<GateVerdict>((resolve) => {
		let unlisten = () => {};
		const onAbort = () => finish("denied");
		const finish = (verdict: GateVerdict) => {
			unlisten();
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(verdict);
		};
		const timer = setTimeout(() => finish("timeout"), deps.gate.cloudTimeoutSec * 1000);
		unlisten = deps.transport.waitForDecision(approvalId, finish);
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
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
