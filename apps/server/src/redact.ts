const REDACTION_RULES: Array<{ type: string; pattern: RegExp }> = [
	{ type: "private_key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
	{ type: "authorization", pattern: /\b(?:authorization|proxy-authorization)\s*[:=]\s*(?:bearer|basic)?\s*[A-Za-z0-9._~+/=-]+/gi },
	{ type: "secret", pattern: /\b(?:api[_-]?key|secret|token|password|passwd)\s*[:=]\s*["']?[^\s,"'}]+/gi },
	{ type: "openai_key", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
	{ type: "github_key", pattern: /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
	{ type: "aws_key", pattern: /\bAKIA[A-Z0-9]{16}\b/g },
	{ type: "slack_key", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
	{ type: "jwt", pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
	{ type: "credential_url", pattern: /\bhttps?:\/\/[^\s/:@]+:[^\s/@]+@[^\s]+/gi },
	{ type: "email", pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
	{ type: "home_path", pattern: /\b[A-Z]:\\Users\\[^\\\s]+|\/(?:Users|home)\/[^/\s]+/gi },
	{ type: "ipv4", pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g },
	{ type: "phone", pattern: /(?<![\w.-])(?:\+?\d[\d ()-]{7,}\d)(?![\w.-])/g },
];

export type Redactable = string | number | boolean | null | Redactable[] | { [key: string]: Redactable };

export interface RedactionResult<T> {
	value: T;
	count: number;
}

export function redactText(input: string): RedactionResult<string> {
	let value = input;
	let count = 0;
	for (const rule of REDACTION_RULES) {
		value = value.replace(rule.pattern, () => {
			count++;
			return `[REDACTED:${rule.type}]`;
		});
	}
	return { value, count };
}

export function redactForModel<T extends Redactable>(input: T): RedactionResult<T> {
	let count = 0;
	function visit(value: Redactable): Redactable {
		if (typeof value === "string") {
			const redacted = redactText(value);
			count += redacted.count;
			return redacted.value;
		}
		if (Array.isArray(value)) return value.map(visit);
		if (value && typeof value === "object") {
			return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]));
		}
		return value;
	}
	return { value: visit(input) as T, count };
}
