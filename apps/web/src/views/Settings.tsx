import { useEffect, useState } from "react";
import type { ModelSettingsDTO, ModelSettingsInput, UserDTO } from "@pi-kanban/shared";
import { apiErrorMessage, apiPost, useResource } from "../api.js";
import { useI18n } from "../i18n.js";
import type { MsgKey } from "../i18n.js";
import {
	disableNotifications,
	enableNotifications,
	loadNotifyPref,
	notificationsBlocked,
	useTheme,
	type ThemePref,
} from "../settings.js";

const THEME_OPTIONS: Array<{ value: ThemePref; key: "light" | "dark" | "system" }> = [
	{ value: "light", key: "light" },
	{ value: "dark", key: "dark" },
	{ value: "system", key: "system" },
];

const INTERVAL_MINUTES = [5, 15, 30, 60, 180, 360, 1440];
/** Monday-first display order; values are Date.getDay() day numbers. */
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
/** 2024-01-07 is a Sunday, so day d maps to a real date for Intl formatting. */
const WEEKDAY_ANCHOR = new Date(2024, 0, 7);

function minutesToTime(minutes: number): string {
	return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function timeToMinutes(value: string): number {
	const [hours, minutes] = value.split(":").map(Number);
	return hours * 60 + minutes;
}

interface MeResponse {
	user: UserDTO;
}

export function Settings() {
	const { t } = useI18n();
	const [theme, setTheme] = useTheme();
	const [notify, setNotify] = useState(loadNotifyPref);
	const [notifyBlocked, setNotifyBlocked] = useState(notificationsBlocked);
	const { data: me } = useResource<MeResponse>("/api/auth/me");
	const isAdmin = me?.user.role === "admin";

	async function toggleNotify(on: boolean) {
		if (!on) {
			disableNotifications();
			setNotify(false);
			return;
		}
		const granted = await enableNotifications();
		setNotify(granted);
		setNotifyBlocked(notificationsBlocked());
	}

	return (
		<div className="account settings">
			<header>
				<h1 className="page-title">{t("settings.title")}</h1>
			</header>
			<section className="account-section">
				<h2>{t("settings.appearance")}</h2>
				<div className="setting-row">
					<div>
						<strong>{t("settings.theme")}</strong>
						<p className="muted">{t("settings.themeHint")}</p>
					</div>
					<div className="seg" role="radiogroup" aria-label={t("settings.theme")}>
						{THEME_OPTIONS.map(({ value, key }) => (
							<button
								key={value}
								type="button"
								className={theme === value ? "on" : ""}
								aria-checked={theme === value}
								role="radio"
								onClick={() => setTheme(value)}
							>
								{t(`settings.theme.${key}` as const)}
							</button>
						))}
					</div>
				</div>
			</section>
			<section className="account-section">
				<h2>{t("settings.notifications")}</h2>
				<div className="setting-row">
					<div>
						<strong>{t("settings.notifyToggle")}</strong>
						<p className="muted">{t("settings.notifyHint")}</p>
						{notifyBlocked && <p className="error">{t("settings.notifyBlocked")}</p>}
					</div>
					<button
						type="button"
						role="switch"
						className={`switch ${notify ? "on" : ""}`}
						aria-checked={notify}
						aria-label={t("settings.notifyToggle")}
						onClick={() => void toggleNotify(!notify)}
					>
						<span className="switch-knob" />
					</button>
				</div>
			</section>
			{isAdmin && <ModelSettingsSection />}
		</div>
	);
}

/**
 * Admin-only global model connection used for project inspections. The API
 * key is write-only: the server never echoes it back, so the field always
 * starts empty and an empty submit keeps the saved key.
 */
function ModelSettingsSection() {
	const { t, locale } = useI18n();
	const [refreshKey, setRefreshKey] = useState(0);
	const { data, error, loading } = useResource<ModelSettingsDTO>("/api/settings/model", refreshKey);
	const [baseUrl, setBaseUrl] = useState("");
	const [model, setModel] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [enabled, setEnabled] = useState(false);
	const [intervalMinutes, setIntervalMinutes] = useState(60);
	const [windowStart, setWindowStart] = useState("00:00");
	const [windowEnd, setWindowEnd] = useState("23:59");
	const [weekdays, setWeekdays] = useState<Set<number>>(new Set(WEEKDAY_ORDER));
	const [dirty, setDirty] = useState(false);
	const [busy, setBusy] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);
	const [testOk, setTestOk] = useState(false);
	const [testError, setTestError] = useState<string | null>(null);

	// Sync form fields from the server until the user edits something.
	useEffect(() => {
		if (!data || dirty) return;
		setBaseUrl(data.baseUrl);
		setModel(data.model);
		setEnabled(data.enabled);
		setIntervalMinutes(data.intervalMinutes);
		setWindowStart(minutesToTime(data.windowStartMinute));
		setWindowEnd(minutesToTime(data.windowEndMinute));
		setWeekdays(new Set(data.weekdays));
	}, [data, dirty]);

	function markDirty() {
		setDirty(true);
		setSaved(false);
	}

	function toggleWeekday(day: number) {
		markDirty();
		// The server rejects an empty weekday list; keep at least one day on.
		setWeekdays((current) => {
			if (current.size === 1 && current.has(day)) return current;
			const next = new Set(current);
			if (next.has(day)) next.delete(day);
			else next.add(day);
			return next;
		});
	}

	const weekdayLabel = (day: number): string =>
		new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", { weekday: "short" }).format(
			new Date(WEEKDAY_ANCHOR.getFullYear(), WEEKDAY_ANCHOR.getMonth(), WEEKDAY_ANCHOR.getDate() + day),
		);

	async function save(event: React.SyntheticEvent<HTMLFormElement>) {
		event.preventDefault();
		setBusy(true);
		setSaveError(null);
		setSaved(false);
		const key = apiKey.trim();
		if (!windowStart || !windowEnd) {
			setSaveError(t("settings.model.windowInvalid"));
			return;
		}
		const body: ModelSettingsInput = {
			baseUrl: baseUrl.trim(),
			model: model.trim(),
			enabled,
			intervalMinutes,
			windowStartMinute: timeToMinutes(windowStart),
			windowEndMinute: timeToMinutes(windowEnd),
			weekdays: [...weekdays].sort((a, b) => a - b),
			// Omitted → keep the current key on the server.
			...(key ? { apiKey: key } : {}),
		};
		try {
			await apiPost<ModelSettingsDTO>("/api/settings/model", body);
			setApiKey("");
			setDirty(false);
			setSaved(true);
			setRefreshKey((k) => k + 1);
		} catch (err) {
			setSaveError(apiErrorMessage(err));
		} finally {
			setBusy(false);
		}
	}

	async function testConnection() {
		setBusy(true);
		setTestError(null);
		setTestOk(false);
		try {
			await apiPost<{ ok: boolean }>("/api/settings/model/test", {});
			setTestOk(true);
		} catch (err) {
			setTestError(apiErrorMessage(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<section className="account-section">
			<h2>{t("settings.model.title")}</h2>
			<p className="muted">{t("settings.model.hint")}</p>
			{error ? (
				<div className="error">{apiErrorMessage(error)}</div>
			) : loading && !data ? (
				<p className="muted">{t("common.loading")}</p>
			) : (
				<>
					<form className="inline-form model-form" onSubmit={(event) => void save(event)}>
						<input
							value={baseUrl}
							onChange={(event) => { markDirty(); setBaseUrl(event.target.value); }}
							placeholder={t("settings.model.baseUrl")}
							aria-label={t("settings.model.baseUrl")}
							required
						/>
						<input
							value={model}
							onChange={(event) => { markDirty(); setModel(event.target.value); }}
							placeholder={t("settings.model.model")}
							aria-label={t("settings.model.model")}
							required
						/>
						<input
							type="password"
							value={apiKey}
							onChange={(event) => { markDirty(); setApiKey(event.target.value); }}
							placeholder={data?.hasApiKey ? t("settings.model.apiKeySaved") : t("settings.model.apiKeyMissing")}
							aria-label={t("settings.model.apiKey")}
							autoComplete="new-password"
						/>
						<button type="submit" disabled={busy}>{t("settings.model.save")}</button>
					</form>
					<p className="muted">{t("settings.model.apiKeyHint")}</p>
					{saveError && <p className="error">{saveError}</p>}
					{saved && <p className="model-saved">{t("settings.model.saved")}</p>}
					<div className="setting-row">
						<div>
							<strong>{t("settings.model.interval")}</strong>
							<p className="muted">{t("settings.model.scheduleHint")}</p>
						</div>
						<select
							value={intervalMinutes}
							onChange={(event) => { markDirty(); setIntervalMinutes(Number(event.target.value)); }}
							aria-label={t("settings.model.interval")}
						>
							{INTERVAL_MINUTES.map((minutes) => (
								<option key={minutes} value={minutes}>
									{t(`settings.model.interval.${minutes}` as MsgKey)}
								</option>
							))}
						</select>
					</div>
					<div className="setting-row">
						<div>
							<strong>{t("settings.model.window")}</strong>
						</div>
						<div className="schedule-window">
							<input
								type="time"
								value={windowStart}
								onChange={(event) => { markDirty(); setWindowStart(event.target.value); }}
								aria-label={t("settings.model.window")}
							/>
							<span className="muted" aria-hidden="true">–</span>
							<input
								type="time"
								value={windowEnd}
								onChange={(event) => { markDirty(); setWindowEnd(event.target.value); }}
								aria-label={t("settings.model.window")}
							/>
						</div>
					</div>
					<div className="setting-row">
						<div>
							<strong>{t("settings.model.weekdays")}</strong>
						</div>
						<div className="seg weekday-seg" role="group" aria-label={t("settings.model.weekdays")}>
							{WEEKDAY_ORDER.map((day) => (
								<button
									key={day}
									type="button"
									className={weekdays.has(day) ? "on" : ""}
									aria-pressed={weekdays.has(day)}
									onClick={() => toggleWeekday(day)}
								>
									{weekdayLabel(day)}
								</button>
							))}
						</div>
					</div>
					<div className="setting-row">
						<div>
							<strong>{t("settings.model.enabled")}</strong>
							<p className="muted">{t("settings.model.enabledHint")}</p>
						</div>
						<button
							type="button"
							role="switch"
							className={`switch ${enabled ? "on" : ""}`}
							aria-checked={enabled}
							aria-label={t("settings.model.enabled")}
							onClick={() => { markDirty(); setEnabled(!enabled); }}
						>
							<span className="switch-knob" />
						</button>
					</div>
					<div className="setting-row">
						<div>
							<strong>{t("settings.model.test")}</strong>
							<p className="muted">{t("settings.model.testHint")}</p>
							{testOk && <p className="model-saved">{t("settings.model.testOk")}</p>}
							{testError && <p className="error">{t("settings.model.testFailed")}: {testError}</p>}
						</div>
						<button type="button" disabled={busy} onClick={() => void testConnection()}>
							{t("settings.model.test")}
						</button>
					</div>
				</>
			)}
		</section>
	);
}
