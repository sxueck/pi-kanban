import { useState } from "react";
import { Link } from "react-router-dom";
import type { SearchScope, SearchResultDTO } from "@pi-kanban/shared";
import { fmtAgo, useResource } from "../api.js";
import { useI18n } from "../i18n.js";
import { EmptyState, ErrorState, SkeletonRows } from "../components/states.js";

const SCOPES: SearchScope[] = ["all", "sessions", "memories"];

/**
 * Cross-project cloud search: ranked session summaries and decision-point
 * memories across every project of the account. Full transcript replay stays
 * a local-session concern (the hint line points at session_search).
 */
export function Search() {
	const { t, locale } = useI18n();
	const [query, setQuery] = useState("");
	const [submitted, setSubmitted] = useState("");
	const [scope, setScope] = useState<SearchScope>("all");
	const [refreshKey, setRefreshKey] = useState(0);
	const path = submitted ? `/api/search?q=${encodeURIComponent(submitted)}&scope=${scope}` : null;
	const { data, error, loading } = useResource<SearchResultDTO>(path, refreshKey);
	const results = data;
	// Scores are BM25-ish and unbounded: show them as a bar relative to the best hit.
	const top = Math.max(1, ...(results ? [...results.sessions, ...results.memories].map((h) => h.score) : []));

	function submitSearch(value = query) {
		setQuery(value);
		setSubmitted(value.trim());
	}

	function clearSearch() {
		setQuery("");
		setSubmitted("");
	}

	return (
		<div className="search-view">
			<header className="page-head">
				<div>
					<h1 className="page-title">{t("search.title")}</h1>
					<p>{t("search.subtitle")}</p>
				</div>
			</header>
			<form
				className="search-form"
				onSubmit={(event) => {
					event.preventDefault();
					submitSearch();
				}}
			>
				<label className="field">
					<span className="sr-only">{t("search.placeholder")}</span>
					<input autoFocus value={query} placeholder={t("search.placeholder")} onChange={(event) => setQuery(event.target.value)} />
				</label>
				<div className="board-chips" role="group" aria-label={t("search.scopeLabel")}>
					{SCOPES.map((value) => (
						<button
							key={value}
							type="button"
							className={scope === value ? "on" : ""}
							aria-pressed={scope === value}
							disabled={loading}
							onClick={() => setScope(value)}
						>
							{t(`search.scope.${value}`)}
						</button>
					))}
				</div>
				<button type="submit" disabled={!query.trim() || loading}>
					{t("search.submit")}
				</button>
				{submitted && (
					<button className="secondary search-clear" type="button" onClick={clearSearch}>
						{t("search.clear")}
					</button>
				)}
			</form>
			<div aria-live="polite">
				{!submitted && <SearchIdle onExample={submitSearch} />}
				{error && <ErrorState error={error} onRetry={() => setRefreshKey((k) => k + 1)} />}
				{path && loading && !results && <SkeletonRows count={4} />}
				{results && results.sessions.length === 0 && results.memories.length === 0 && (
					<EmptyState title={t("search.empty")} hint={t("search.emptyHint", { query: submitted, scope: t(`search.scope.${scope}`) })} />
				)}
			</div>
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
									<span className="search-score" title={t("search.relevance", { n: hit.score.toFixed(2) })}>
										<span className="score-bar" style={{ "--p": `${Math.round((hit.score / top) * 100)}%` } as React.CSSProperties} />
									</span>
								</div>
								{hit.snippet && <p className="work-detail">…{hit.snippet}</p>}
								<div className="memory-meta">
									{fmtAgo(hit.matchedAt, locale)}
									{hit.turnPosition != null && <> · {t("search.turn", { n: hit.turnPosition })}</>}
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
									<span className="search-score" title={t("search.relevance", { n: hit.score.toFixed(2) })}>
										<span className="score-bar" style={{ "--p": `${Math.round((hit.score / top) * 100)}%` } as React.CSSProperties} />
									</span>
								</div>
								<p className="memory-content">{hit.content}</p>
								<div className="memory-meta">
									{t(`memory.status.${hit.status}`)} · {fmtAgo(hit.lastSeenAt, locale)}
								</div>
							</li>
						))}
					</ul>
				</section>
			)}
		</div>
	);
}

function SearchIdle({ onExample }: { onExample: (query: string) => void }) {
	const { t } = useI18n();
	const examples = t("search.exampleQueries").split(",").map((part) => part.trim()).filter(Boolean);
	return (
		<section className="search-idle" aria-labelledby="search-idle-title">
			<div>
				<h2 id="search-idle-title">{t("search.idle.title")}</h2>
				<p>{t("search.idle.body")}</p>
			</div>
			<div className="search-examples" aria-label={t("search.examples")}>
				{examples.map((example) => (
					<button key={example} type="button" className="secondary" onClick={() => onExample(example)}>
						{example}
					</button>
				))}
			</div>
		</section>
	);
}
