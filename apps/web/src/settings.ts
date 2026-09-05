import { useCallback, useEffect, useState } from "react";

/**
 * Client-side preferences (theme, notifications) persisted in localStorage.
 * Theme applies via [data-theme] on <html>; "system" tracks prefers-color-scheme.
 */

export type ThemePref = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const THEME_KEY = "pi-kanban-theme";
const NOTIFY_KEY = "pi-kanban-notify";

export function loadThemePref(): ThemePref {
	try {
		const saved = localStorage.getItem(THEME_KEY);
		if (saved === "light" || saved === "dark" || saved === "system") return saved;
	} catch {
		// storage unavailable — fall through to system default
	}
	return "system";
}

export function storeThemePref(pref: ThemePref): void {
	try {
		localStorage.setItem(THEME_KEY, pref);
	} catch {
		// best effort only
	}
}

export function resolveTheme(pref: ThemePref): ResolvedTheme {
	if (pref !== "system") return pref;
	return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(pref: ThemePref): void {
	document.documentElement.dataset.theme = resolveTheme(pref);
}

/** Theme preference state; keeps [data-theme] in sync incl. OS scheme changes. */
export function useTheme(): [ThemePref, (pref: ThemePref) => void] {
	const [pref, setPref] = useState<ThemePref>(loadThemePref);
	useEffect(() => {
		applyTheme(pref);
		if (pref !== "system") return;
		const media = window.matchMedia("(prefers-color-scheme: dark)");
		const onChange = () => applyTheme(pref);
		media.addEventListener("change", onChange);
		return () => media.removeEventListener("change", onChange);
	}, [pref]);
	const update = useCallback((next: ThemePref) => {
		storeThemePref(next);
		setPref(next);
	}, []);
	return [pref, update];
}

export function loadNotifyPref(): boolean {
	try {
		return localStorage.getItem(NOTIFY_KEY) === "1";
	} catch {
		return false;
	}
}

function storeNotifyPref(on: boolean): void {
	try {
		localStorage.setItem(NOTIFY_KEY, on ? "1" : "0");
	} catch {
		// best effort only
	}
}

export function notificationsBlocked(): boolean {
	return "Notification" in window && Notification.permission === "denied";
}

/** Turn notifications on: requests permission first; returns whether it stuck. */
export async function enableNotifications(): Promise<boolean> {
	if (!("Notification" in window)) return false;
	if (Notification.permission === "denied") return false;
	if (Notification.permission !== "granted") {
		const permission = await Notification.requestPermission();
		if (permission !== "granted") return false;
	}
	storeNotifyPref(true);
	return true;
}

export function disableNotifications(): void {
	storeNotifyPref(false);
}

/** Fire a system notification when the pending-approval count grows. */
export function notifyNewApprovals(body: string): void {
	if (!loadNotifyPref()) return;
	if (!("Notification" in window) || Notification.permission !== "granted") return;
	new Notification("pi-kanban", { body, tag: "pi-kanban-approvals" });
}
