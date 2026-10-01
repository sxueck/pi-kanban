import { useI18n } from "../i18n.js";
import type { MsgKey } from "../i18n.js";

/** Shared loading placeholder: N placeholder rows plus a screen-reader label. */
export function Skeleton({ className, rows, rowClassName, labelKey }: {
	className: string;
	rows: number;
	rowClassName?: string;
	labelKey: MsgKey;
}) {
	const { t } = useI18n();
	return (
		<div className={className} aria-live="polite" aria-label={t(labelKey)}>
			<span className="sr-only">{t(labelKey)}</span>
			{Array.from({ length: rows }, (_, index) => <div key={index} className={rowClassName} />)}
		</div>
	);
}
