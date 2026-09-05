import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { eq, isNull, sql } from "drizzle-orm";
import type { ModelSettingsDTO, ModelSettingsInput } from "@pi-kanban/shared";
import { db } from "./db/index.js";
import { modelSettings, projectAnalysisStates } from "./db/schema.js";

const SETTINGS_ID = 1;
const MIN_INTERVAL_MINUTES = 5;
const MAX_INTERVAL_MINUTES = 24 * 60;
const INTERVAL_OPTIONS = new Set([5, 15, 30, 60, 180, 360, 1440]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function encryptionKey(): Buffer {
	const secret = process.env.MODEL_SETTINGS_SECRET;
	if (!secret || secret.length < 32) {
		throw new Error("MODEL_SETTINGS_SECRET must contain at least 32 characters");
	}
	return createHash("sha256").update(secret).digest();
}

export function encryptApiKey(value: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv, { authTagLength: 16 });
	const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
	return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptApiKey(value: string): string {
	const [version, ivText, tagText, encryptedText] = value.split(".");
	if (version !== "v1" || !ivText || !tagText || !encryptedText) throw new Error("invalid encrypted API key");
	const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivText, "base64url"), { authTagLength: 16 });
	decipher.setAuthTag(Buffer.from(tagText, "base64url"));
	return Buffer.concat([
		decipher.update(Buffer.from(encryptedText, "base64url")),
		decipher.final(),
	]).toString("utf8");
}

export function validateModelSettings(input: ModelSettingsInput): ModelSettingsInput {
	if (
		typeof input.baseUrl !== "string" ||
		typeof input.model !== "string" ||
		typeof input.enabled !== "boolean" ||
		typeof input.intervalMinutes !== "number" ||
		(input.apiKey !== undefined && typeof input.apiKey !== "string")
	) {
		throw new Error("invalid model settings fields");
	}
	let url: URL;
	try {
		url = new URL(input.baseUrl.trim());
	} catch {
		throw new Error("baseUrl must be a valid HTTP(S) URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("baseUrl must be a valid HTTP(S) URL");
	}
	if (url.username || url.password) throw new Error("baseUrl must not contain credentials");
	if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
		throw new Error("remote model connections must use HTTPS");
	}
	const baseUrl = url.toString().replace(/\/$/, "");
	const model = input.model.trim();
	if (!model || model.length > 200) throw new Error("model must contain 1-200 characters");
	if (!Number.isInteger(input.intervalMinutes) || input.intervalMinutes < MIN_INTERVAL_MINUTES || input.intervalMinutes > MAX_INTERVAL_MINUTES || !INTERVAL_OPTIONS.has(input.intervalMinutes)) {
		throw new Error("intervalMinutes must be one of 5, 15, 30, 60, 180, 360, or 1440");
	}
	return { ...input, baseUrl, model };
}

export async function readModelSettings() {
	const [row] = await db.select().from(modelSettings).where(eq(modelSettings.id, SETTINGS_ID)).limit(1);
	return row;
}

export type InspectionSchedulePlan =
	| { type: "none" }
	/** Enable transition: idle states become due at the next sweep. */
	| { type: "schedule-idle-now" }
	/** Interval change while enabled: pull idle states earlier, never delay one. */
	| { type: "reschedule-idle"; capAt: Date }
	/** Disable transition: idle states stop; live locks are untouched. */
	| { type: "clear-schedule" };

/**
 * Decides how project_analysis_states schedules should react to a settings
 * save. Rules:
 * - Only the disabled→enabled transition schedules projects (idle states run
 *   at the next sweep); plain re-saves while enabled never reset schedules.
 * - Interval changes reschedule idle states to min(existing, now+interval),
 *   so an already-due inspection is never pushed further out.
 * - Disabling clears schedules for idle states only — a live lock
 *   (lockedAt) is never cleared, so an in-flight inspection cannot cause
 *   concurrent re-entry into the same project.
 * - Locked rows are left alone in every case; the run that owns the lock
 *   reschedules on completion or failure.
 */
export function planInspectionSchedule(
	previous: { enabled: boolean; intervalMinutes: number } | undefined,
	next: { enabled: boolean; intervalMinutes: number },
	now: Date,
): InspectionSchedulePlan {
	if (!next.enabled) return previous?.enabled ? { type: "clear-schedule" } : { type: "none" };
	if (!previous?.enabled) return { type: "schedule-idle-now" };
	if (next.intervalMinutes !== previous.intervalMinutes) {
		return { type: "reschedule-idle", capAt: new Date(now.getTime() + next.intervalMinutes * 60_000) };
	}
	return { type: "none" };
}

async function applyInspectionSchedulePlan(
	tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
	plan: InspectionSchedulePlan,
	now: Date,
): Promise<void> {
	if (plan.type === "schedule-idle-now") {
		await tx.update(projectAnalysisStates).set({ nextInspectionAt: now, updatedAt: now }).where(isNull(projectAnalysisStates.lockedAt));
	} else if (plan.type === "clear-schedule") {
		// lockedAt is deliberately not touched: a live inspection keeps its claim.
		await tx.update(projectAnalysisStates).set({ nextInspectionAt: null, updatedAt: now }).where(isNull(projectAnalysisStates.lockedAt));
	} else if (plan.type === "reschedule-idle") {
		await tx.update(projectAnalysisStates).set({
			nextInspectionAt: sql`least(coalesce(${projectAnalysisStates.nextInspectionAt}, 'infinity'::timestamptz), ${plan.capAt})`,
			updatedAt: now,
		}).where(isNull(projectAnalysisStates.lockedAt));
	}
}

export async function saveModelSettings(input: ModelSettingsInput): Promise<ModelSettingsDTO> {
	const valid = validateModelSettings(input);
	return db.transaction(async (tx) => {
		const now = new Date();
		await tx.insert(modelSettings).values({ id: SETTINGS_ID }).onConflictDoNothing({ target: modelSettings.id });
		const [existing] = await tx.select().from(modelSettings).where(eq(modelSettings.id, SETTINGS_ID)).for("update").limit(1);
		let apiKeyCipher = existing?.apiKeyCipher ?? null;
		if (valid.apiKey !== undefined) apiKeyCipher = valid.apiKey.trim() ? encryptApiKey(valid.apiKey.trim()) : null;
		if (valid.enabled && !apiKeyCipher) throw new Error("an API key is required when inspection is enabled");
		const schedulePlan = planInspectionSchedule(
			existing ? { enabled: existing.enabled, intervalMinutes: existing.inspectionIntervalMinutes } : undefined,
			{ enabled: valid.enabled, intervalMinutes: valid.intervalMinutes },
			now,
		);
		const [row] = await tx
			.update(modelSettings)
			.set({
				baseUrl: valid.baseUrl,
				model: valid.model,
				apiKeyCipher,
				enabled: valid.enabled,
				inspectionIntervalMinutes: valid.intervalMinutes,
				updatedAt: now,
			})
			.where(eq(modelSettings.id, SETTINGS_ID))
			.returning();
		// Runs in the same transaction as the settings write so a schedule
		// change and its settings never disagree if one of them fails.
		await applyInspectionSchedulePlan(tx, schedulePlan, now);
		return toModelSettingsDto(row);
	});
}

export function toModelSettingsDto(row: typeof modelSettings.$inferSelect | undefined): ModelSettingsDTO {
	return {
		baseUrl: row?.baseUrl ?? "",
		model: row?.model ?? "gpt-4o-mini",
		enabled: row?.enabled ?? false,
		intervalMinutes: row?.inspectionIntervalMinutes ?? 60,
		hasApiKey: Boolean(row?.apiKeyCipher),
		updatedAt: row?.updatedAt.getTime(),
	};
}
