import type { CSSProperties, ReactNode } from "react";
import { useI18n } from "../i18n.js";
import { apiErrorMessage } from "../api.js";

/**
 * Shared load/empty/error surfaces. Every route used to hand-roll its own
 * variant, which is how three different "loading" treatments shipped.
 */

export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
	return <span className={`skeleton${className ? ` ${className}` : ""}`} style={style} aria-hidden="true" />;
}

/** A block of placeholder cards sized to the real thing, so data landing never shifts layout. */
export function SkeletonCards({ count = 6, min = 3 }: { count?: number; min?: number }) {
	const { t } = useI18n();
	return (
		<div className="skeleton-grid" style={{ "--cols": min } as CSSProperties} role="status" aria-live="polite">
			<span className="sr-only">{t("common.loading")}</span>
			{Array.from({ length: count }, (_, i) => (
				<span className="skeleton skeleton-card" key={i} style={{ "--i": i } as CSSProperties} />
			))}
		</div>
	);
}

export function SkeletonRows({ count = 5 }: { count?: number }) {
	const { t } = useI18n();
	return (
		<div className="skeleton-rows" role="status" aria-live="polite">
			<span className="sr-only">{t("common.loading")}</span>
			{Array.from({ length: count }, (_, i) => (
				<span className="skeleton skeleton-row" key={i} style={{ "--i": i, "--w": `${88 - ((i * 13) % 34)}%` } as CSSProperties} />
			))}
		</div>
	);
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
	const { t } = useI18n();
	return (
		<div className="error-state" role="alert">
			<svg className="error-glyph" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
				<path d="M12 8.5v5" />
				<path d="M12 16.8h.01" />
				<circle cx="12" cy="12" r="8.6" />
			</svg>
			<div className="error-copy">
				<strong>{t("common.errorTitle")}</strong>
				<p>{apiErrorMessage(error)}</p>
			</div>
			{onRetry && (
				<button type="button" onClick={onRetry}>
					{t("common.retry")}
				</button>
			)}
		</div>
	);
}

export function EmptyState({ illustration, title, hint, action }: { illustration?: ReactNode; title: string; hint?: string; action?: ReactNode }) {
	return (
		<div className="empty-state">
			{illustration && <div className="empty-art">{illustration}</div>}
			<h2>{title}</h2>
			{hint && <p>{hint}</p>}
			{action}
		</div>
	);
}
