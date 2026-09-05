import { useEffect, useState } from "react";
import { Link, Route, Routes, useLocation } from "react-router-dom";
import { apiGetPublic, apiPost, apiPostPublic, clearToken, getToken, setToken, UNAUTHORIZED_EVENT } from "./api.js";
import { useI18n } from "./i18n.js";
import { GateIllustration, NotFoundIllustration } from "./components/illustrations.js";
import { Account } from "./views/Account.js";
import { Board } from "./views/Board.js";
import { Approvals } from "./views/Approvals.js";
import { History, ProjectSessions } from "./views/History.js";
import { SessionDetail } from "./views/SessionDetail.js";

interface AuthResponse {
	token: string;
	user: { id: string; username: string; role: "admin" | "member" };
}

export function App() {
	const [authed, setAuthed] = useState(() => Boolean(getToken()));
	useEffect(() => {
		const onUnauthorized = () => {
			clearToken();
			setAuthed(false);
		};
		window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
		return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
	}, []);
	if (!authed) return <AuthGate onOk={() => setAuthed(true)} />;
	return (
		<div className="app">
			<Nav />
			<main className="content">
				<Routes>
					<Route path="/" element={<Board />} />
					<Route path="/approvals" element={<Approvals />} />
					<Route path="/history" element={<History />} />
					<Route path="/history/project/:id" element={<ProjectSessions />} />
					<Route path="/sessions/:id" element={<SessionDetail />} />
					<Route path="/account" element={<Account />} />
					<Route path="*" element={<NotFound />} />
				</Routes>
			</main>
		</div>
	);
}

function AuthGate({ onOk }: { onOk: () => void }) {
	const { t } = useI18n();
	const [setupRequired, setSetupRequired] = useState<boolean | null>(null);
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [bootstrapToken, setBootstrapToken] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);

	useEffect(() => {
		void apiGetPublic<{ setupRequired: boolean }>("/api/auth/status")
			.then((status) => setSetupRequired(status.setupRequired))
			.catch((err: unknown) => setError(err instanceof Error ? err.message : t("gate.failed")));
	}, [t]);

	async function submit(event: React.SyntheticEvent<HTMLFormElement>) {
		event.preventDefault();
		if (setupRequired == null) return;
		setSubmitting(true);
		setError(null);
		try {
			const response = setupRequired
				? await apiPostPublic<AuthResponse>(
						"/api/auth/bootstrap",
						{ username, password },
						{ authorization: `Bearer ${bootstrapToken}` },
					)
				: await apiPostPublic<AuthResponse>("/api/auth/login", { username, password });
			setToken(response.token);
			onOk();
		} catch (err) {
			setError(err instanceof Error ? err.message : t("gate.failed"));
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<div className="token-gate">
			<div className="gate-card">
				<GateIllustration />
				<h1>pi-kanban</h1>
				<p>{setupRequired ? t("gate.setupIntro") : t("gate.loginIntro")}</p>
				<form onSubmit={(event) => void submit(event)}>
					<input placeholder={t("auth.username")} value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" autoFocus required />
					<input type="password" placeholder={t("auth.password")} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={setupRequired ? "new-password" : "current-password"} required />
					{setupRequired && <input type="password" placeholder={t("auth.bootstrapToken")} value={bootstrapToken} onChange={(event) => setBootstrapToken(event.target.value)} required />}
					<button type="submit" disabled={submitting || setupRequired == null}>
						{setupRequired ? t("gate.createAdmin") : t("gate.signIn")}
					</button>
				</form>
				{error && <p className="error">{error}</p>}
			</div>
		</div>
	);
}

function Nav() {
	const { t, locale, setLocale } = useI18n();
	const { pathname } = useLocation();
	const pendingBadge = usePendingCount();
	const links: Array<[string, string]> = [
		["/", t("nav.board")],
		["/approvals", t("nav.approvals")],
		["/history", t("nav.history")],
		["/account", t("nav.account")],
	];
	const nextLocale = locale === "zh" ? "en" : "zh";
	return (
		<nav className="nav">
			<div className="nav-brand">
				<span className="brand-icon">π</span>
				<span className="nav-label">pi-kanban</span>
			</div>
			{links.map(([to, label]) => (
				<Link key={to} to={to} className={pathname === to ? "active" : ""}>
					<span className="nav-label">{label}</span>
					{to === "/approvals" && pendingBadge > 0 && <span className="badge">{pendingBadge}</span>}
				</Link>
			))}
			<div className="nav-footer">
				<button type="button" className="lang-switch" onClick={() => setLocale(nextLocale)} aria-label={t("nav.switchLanguage")} aria-pressed={locale === "zh"}>
					<span aria-hidden="true">{locale === "zh" ? "中" : "EN"}</span>
					<span className="nav-label">{locale === "zh" ? "中文" : "English"}</span>
				</button>
				<button type="button" onClick={() => void logout()}>
					<span className="nav-label">{t("nav.logout")}</span>
				</button>
			</div>
		</nav>
	);
}

async function logout(): Promise<void> {
	try {
		await apiPost("/api/auth/logout", {});
	} catch {
		// Clear the local credential even if the server is unavailable.
	} finally {
		clearToken();
		location.reload();
	}
}

function usePendingCount(): number {
	const [count, setCount] = useState(0);
	useEffect(() => {
		let cancelled = false;
		const load = () => {
			fetch("/api/approvals?status=pending", { headers: { authorization: `Bearer ${getToken()}` } })
				.then((res) => (res.ok ? res.json() : []))
				.then((rows: unknown[]) => {
					if (!cancelled) setCount(rows.length);
				})
				.catch(() => {});
		};
		load();
		const timer = setInterval(load, 10_000);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, []);
	return count;
}

function NotFound() {
	const { t } = useI18n();
	return (
		<div className="empty">
			<NotFoundIllustration />
			<h2>{t("notfound.title")}</h2>
			<p>{t("notfound.body")}</p>
			<p><Link to="/">{t("notfound.back")}</Link></p>
		</div>
	);
}
