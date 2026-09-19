import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { staticText } from "./static-text.js";

export type Notify = (message: string, detail?: unknown) => void;

const LOG_ENTRY_TYPE = "pi-kanban-log";

/**
 * Plugin notices as dim gray transcript lines instead of console.error:
 * custom entries never enter LLM context, so this stays display-only.
 * Must never throw — callers run inside heartbeats and event handlers.
 */
export function registerNotify(pi: ExtensionAPI): Notify {
	pi.registerEntryRenderer(LOG_ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data as { message?: string; detail?: string };
		const line = data.detail ? `${data.message} (${data.detail})` : (data.message ?? "");
		return staticText(theme.fg("dim", `pi-kanban: ${line}`));
	});
	return (message, detail) => {
		try {
			// Stringify detail here: entries are JSON-persisted, and Error etc. would serialize to {}.
			pi.appendEntry(LOG_ENTRY_TYPE, {
				message,
				detail: detail === undefined ? undefined : String(detail),
			});
		} catch {
			return;
		}
	};
}
