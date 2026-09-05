import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "./db/index.js";
import { agentTokens, users, webSessions } from "./db/schema.js";

const scrypt = promisify(scryptCallback);
const WEB_SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const PASSWORD_KEY_LENGTH = 64;

export interface AuthUser {
	id: string;
	username: string;
	role: "admin" | "member";
}

export function validateUsername(username: unknown): username is string {
	return typeof username === "string" && /^[a-zA-Z0-9_.-]{3,40}$/.test(username);
}

export function validatePassword(password: unknown): password is string {
	return typeof password === "string" && password.length >= 12 && password.length <= 256;
}

export async function hashPassword(password: string): Promise<string> {
	const salt = randomBytes(16);
	const derived = (await scrypt(password, salt, PASSWORD_KEY_LENGTH)) as Buffer;
	return `${salt.toString("base64url")}:${derived.toString("base64url")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
	const [saltText, hashText] = encoded.split(":");
	if (!saltText || !hashText) return false;
	try {
		const actual = (await scrypt(password, Buffer.from(saltText, "base64url"), PASSWORD_KEY_LENGTH)) as Buffer;
		const expected = Buffer.from(hashText, "base64url");
		return expected.length === actual.length && timingSafeEqual(expected, actual);
	} catch {
		return false;
	}
}

export function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

export function newSecret(): string {
	return randomBytes(32).toString("base64url");
}

export function isBootstrapToken(token: string | undefined): boolean {
	const expected = process.env.ADMIN_TOKEN;
	if (!expected || !token) return false;
	const actualBytes = Buffer.from(token);
	const expectedBytes = Buffer.from(expected);
	return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export async function authenticateWebToken(token: string): Promise<AuthUser | null> {
	const [row] = await db
		.select({ id: users.id, username: users.username, role: users.role })
		.from(webSessions)
		.innerJoin(users, eq(webSessions.userId, users.id))
		.where(and(eq(webSessions.tokenHash, hashToken(token)), gt(webSessions.expiresAt, new Date())))
		.limit(1);
	if (!row || (row.role !== "admin" && row.role !== "member")) return null;
	return row as AuthUser;
}

export async function createWebSession(userId: string): Promise<string> {
	const token = newSecret();
	await db.insert(webSessions).values({
		userId,
		tokenHash: hashToken(token),
		expiresAt: new Date(Date.now() + WEB_SESSION_TTL_MS),
	});
	return token;
}

export async function revokeWebSession(token: string): Promise<void> {
	await db.delete(webSessions).where(eq(webSessions.tokenHash, hashToken(token)));
}

export async function authenticateAgentToken(token: string): Promise<{ userId: string } | null> {
	const [row] = await db
		.select({ userId: agentTokens.userId })
		.from(agentTokens)
		.where(and(eq(agentTokens.tokenHash, hashToken(token)), isNull(agentTokens.revokedAt)))
		.limit(1);
	if (!row) return null;
	await db.update(agentTokens).set({ lastUsedAt: new Date() }).where(eq(agentTokens.tokenHash, hashToken(token)));
	return row;
}
