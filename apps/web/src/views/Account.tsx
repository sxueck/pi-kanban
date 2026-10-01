import { useState } from "react";
import type { AgentTokenDTO, UserDTO } from "@pi-kanban/shared";
import { apiDelete, apiPost, fmtAgo, fmtTime, useResource } from "../api.js";
import { ErrorState, SkeletonRows } from "../components/states.js";
import { useI18n } from "../i18n.js";

interface MeResponse {
	user: UserDTO;
}

interface CreatedAgentToken extends AgentTokenDTO {
	token: string;
}

export function Account() {
	const { t, locale } = useI18n();
	const [refreshKey, setRefreshKey] = useState(0);
	const [name, setName] = useState("");
	const [createdToken, setCreatedToken] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const { data: me, error: meError } = useResource<MeResponse>("/api/auth/me", refreshKey);
	const { data: tokens, error: tokensError } = useResource<AgentTokenDTO[]>("/api/agent-tokens", refreshKey);
	const isAdmin = me?.user.role === "admin";
	const { data: users, error: usersError } = useResource<UserDTO[]>(isAdmin ? "/api/users" : null, refreshKey);

	async function createToken(event: React.SyntheticEvent<HTMLFormElement>) {
		event.preventDefault();
		setError(null);
		try {
			const created = await apiPost<CreatedAgentToken>("/api/agent-tokens", { name });
			setCreatedToken(created.token);
			setName("");
			setRefreshKey((key) => key + 1);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	async function revoke(id: string) {
		// Revoking disconnects a machine mid-session, so it confirms like delete-project does.
		if (!window.confirm(t("account.revokeConfirm"))) return;
		setError(null);
		try {
			await apiDelete(`/api/agent-tokens/${id}`);
			setRefreshKey((key) => key + 1);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	return (
		<div className="account">
			<header className="page-head">
				<div>
					<p className="page-eyebrow">{me ? `${me.user.username} · ${isAdmin ? t("account.admin") : t("account.member")}` : t("nav.account")}</p>
					<h1 className="page-title">{t("account.title")}</h1>
					<p>{t("account.subtitle")}</p>
				</div>
			</header>
			{meError && <ErrorState error={meError} onRetry={() => setRefreshKey((k) => k + 1)} />}
			{tokensError && <ErrorState error={tokensError} onRetry={() => setRefreshKey((k) => k + 1)} />}
			{usersError && <ErrorState error={usersError} onRetry={() => setRefreshKey((k) => k + 1)} />}
			<section className="account-section">
				<h2>{t("account.agentTokens")}</h2>
				<p className="muted">{t("account.agentTokenHint")}</p>
				<form className="inline-form" onSubmit={(event) => void createToken(event)}>
					<input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("account.tokenName")} aria-label={t("account.tokenName")} maxLength={80} required />
					<button type="submit">{t("account.createToken")}</button>
				</form>
				{error && <ErrorState error={error} />}
				{createdToken && (
					<div className="token-reveal">
						<p>{t("account.copyHint")}</p>
						<code>{createdToken}</code>
					</div>
				)}
				{tokens == null ? (
					<SkeletonRows count={3} />
				) : (tokens?.length ?? 0) === 0 ? (
					<p className="muted">{t("account.noTokens")}</p>
				) : (
					<ul className="token-list">
						{tokens?.map((token) => (
							<li key={token.id}>
								<div>
									<strong>{token.name}</strong>
								<span>
									{t("account.created", { time: fmtAgo(token.createdAt, locale) })}
									· {token.lastUsedAt ? <span title={fmtTime(token.lastUsedAt)}>{t("account.lastUsed", { time: fmtAgo(token.lastUsedAt, locale) })}</span> : t("account.neverUsed")}
								</span>
							</div>
							<button type="button" className="deny" onClick={() => void revoke(token.id)}>{t("account.revoke")}</button>
							</li>
						))}
					</ul>
				)}
			</section>
			{isAdmin && <UserManagement users={users ?? []} onCreated={() => setRefreshKey((key) => key + 1)} />}
		</div>
	);
}

function UserManagement({ users, onCreated }: { users: UserDTO[]; onCreated: () => void }) {
	const { t } = useI18n();
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [role, setRole] = useState<"admin" | "member">("member");
	const [error, setError] = useState<string | null>(null);

	async function createUser(event: React.SyntheticEvent<HTMLFormElement>) {
		event.preventDefault();
		setError(null);
		try {
			await apiPost("/api/users", { username, password, role });
			setUsername("");
			setPassword("");
			onCreated();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	return (
		<section className="account-section">
			<h2>{t("account.users")}</h2>
			<form className="inline-form user-form" onSubmit={(event) => void createUser(event)}>
				<input value={username} onChange={(event) => setUsername(event.target.value)} placeholder={t("auth.username")} aria-label={t("auth.username")} minLength={3} maxLength={40} required />
				<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={t("auth.password")} aria-label={t("auth.password")} minLength={12} required />
				<select value={role} onChange={(event) => setRole(event.target.value as "admin" | "member")} aria-label={t("account.role")}>
					<option value="member">{t("account.member")}</option>
					<option value="admin">{t("account.admin")}</option>
				</select>
				<button type="submit">{t("account.newUser")}</button>
			</form>
			{error && <p className="error">{error}</p>}
			<ul className="user-list">
				{users.map((user) => <li key={user.id}>{user.username}<span>{user.role === "admin" ? t("account.admin") : t("account.member")}</span></li>)}
			</ul>
		</section>
	);
}
