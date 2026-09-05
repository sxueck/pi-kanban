import { useState } from "react";
import { useI18n } from "../i18n.js";
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

export function Settings() {
	const { t } = useI18n();
	const [theme, setTheme] = useTheme();
	const [notify, setNotify] = useState(loadNotifyPref);
	const [notifyBlocked, setNotifyBlocked] = useState(notificationsBlocked);

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
		</div>
	);
}
