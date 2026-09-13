import { useState } from "react";
import { Link } from "react-router-dom";
import type { SearchScope, SearchResultDTO } from "@pi-kanban/shared";
import { apiErrorMessage, fmtTime, useResource } from "../api.js";
import { useI18n } from "../i18n.js";

const SCOPES: SearchScope[] = ["all", "sessions", "memories"];

/**
 * Cross-project cloud search: ranked session summaries and decision-point
 * memories across every project of the account. Full transcript replay stays
 * a local-session concern (the hint line points at session_search).
 */
export function Search() {
	const { t } = useI18n();
	const [query, setQuery] = useState("");
	const [submitted, setSubmitted] = useState("");
	const [scope, setScope] = useState<SearchScope>("all");
	const path = submitted ? `/api/search?q=${encodeURIComponent(submitted)}&scope=${scope}` : null;
	const { data, error, loading } = useResource<SearchResultDTO>(path);
	const results = data;

	return (
		<div className="history search-view">
			<header>
				<h1 className="page-title">{t("search.title")}</h1>
				<form
					className="search-form"
					onSubmit={(event) => {
						event.preventDefault();
						setSubmitted(query.trim());
					}}
				>
					<input
						autoFocus
						value={query}
						placeholder={t("search.placeholder")}
						onChange={(event) => setQuery(event.target.value)}
					/>
					<div className="board-chips" role="group">
						{SCOPES.map((value) => (
							<button
								key={value}
								type="button"
								className={scope === value ? "on" : ""}
								aria-pressed={scope === value}
								onClick={() => setScope(value)}
							>
								{t(`search.scope.${value}`)}
							</button>
						))}
					</div>
					<button type="submit" disabled={!query.trim() || loading}>
						{t("search.submit")}
					</button>
				</form>
				<p className="muted search-hint">{t("search.hint")}</p>
			</header>
			{error && <div className="error">{apiErrorMessage(error)}</div>}
			{loading && !results && <div className="empty">{t("common.loading")}</div>}
			{results && results.sessions.length === 0 && results.memories.length === 0 && (
				<div className="empty">
					<h2>{t("search.empty")}</h2>
				</div>
			)}
			{results && results.sessions.length > 0 && (
				<section className="board-section search-section">
					<header>
						<h2>{t("search.sessions")}</h2>
						<span className="count">{results.sessions.length}</span>
					</header>
					<ul className="search-hit-list">
						{results.sessions.map((hit) => (
							<li key={hit.sessionId} className="search-hit">
								<div className="search-hit-head">
									<Link className="search-hit-link" to={`/sessions/${hit.sessionId}`} title={hit.sessionId}>
										{hit.title ?? `#${hit.sessionId.slice(0, 8)}`}
									</Link>
									<span className="muted">{hit.projectName}</span>
									<span className="search-score">{hit.score.toFixed(2)}</span>
								</div>
								{hit.snippet && <p className="work-detail">…{hit.snippet}</p>}
								<div className="memory-meta">
									{fmtTime(hit.matchedAt)}
									{hit.turnPosition != null && <> · turn {hit.turnPosition}</>}
								</div>
							</li>
						))}
					</ul>
				</section>
			)}
			{results && results.memories.length > 0 && (
				<section className="board-section search-section">
					<header>
						<h2>{t("search.memories")}</h2>
						<span className="count">{results.memories.length}</span>
					</header>
					<ul className="search-hit-list">
						{results.memories.map((hit) => (
							<li key={hit.memoryId} className="search-hit">
								<div className="search-hit-head">
									<span className="work-kind">
										{t(`memory.kind.${hit.kind}`)}
										{hit.scope === "global" ? ` · ${t("search.global")}` : ""}
									</span>
									{hit.projectId != null ? (
										<Link className="search-hit-link" to={`/history/project/${hit.projectId}`}>
											{hit.projectName}
										</Link>
									) : (
										<span className="muted">{hit.projectName}</span>
									)}
									<span className="search-score">{hit.score.toFixed(2)}</span>
								</div>
								<p className="memory-content">{hit.content}</p>
								<div className="memory-meta">
									{t(`memory.status.${hit.status}`)} · {fmtTime(hit.lastSeenAt)}
								</div>
							</li>
						))}
					</ul>
				</section>
			)}
		</div>
	);
}
