// Stateless, signed session cookie: no sessions table, so profile selection / auth state
// costs zero DB round-trips per request and is trivially revoked by rotating SESSION_SECRET.
//
// Cookie value format: `base64url(payload-json).base64url(hmac-sha256-signature)`.
// The payload is never encrypted (only signed) — keep it free of secrets, it's just
// `{ v, auth, profileId }`.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Cookies } from '@sveltejs/kit';
import { config } from '$lib/server/config';

export const SESSION_COOKIE = 'ps_session';

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // ~30 days

export interface SessionPayload {
	v: 1;
	auth: true;
	profileId?: string;
	mode?: 'desktop' | 'tv';
}

export interface SessionData {
	authenticated: boolean;
	profileId: string | null;
	mode: 'desktop' | 'tv' | null;
}

function base64UrlEncode(input: Buffer | string): string {
	return Buffer.from(input).toString('base64url');
}

function sign(data: string): string {
	return createHmac('sha256', config.sessionSecret).update(data).digest('base64url');
}

/** Serialize + sign a session payload into the cookie's string value. */
export function signSession(payload: SessionPayload): string {
	const encodedPayload = base64UrlEncode(JSON.stringify(payload));
	const signature = sign(encodedPayload);
	return `${encodedPayload}.${signature}`;
}

/** Verify a cookie value's signature and shape. Returns null if missing/tampered/invalid. */
export function verifySession(value: string | undefined | null): SessionPayload | null {
	if (!value) return null;

	const dotIndex = value.lastIndexOf('.');
	if (dotIndex === -1) return null;

	const encodedPayload = value.slice(0, dotIndex);
	const signature = value.slice(dotIndex + 1);
	const expectedSignature = sign(encodedPayload);

	// Compare as equal-length buffers: timingSafeEqual throws on length mismatch, which
	// would itself be a (minor) timing/branching leak, so pad/hash first.
	const sigBuf = Buffer.from(signature);
	const expectedBuf = Buffer.from(expectedSignature);
	if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
		return null;
	}

	try {
		const parsed = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
		if (parsed && parsed.v === 1 && parsed.auth === true) {
			return parsed as SessionPayload;
		}
	} catch {
		// malformed JSON → treat as no session
	}

	return null;
}

/** Read the current request's session from cookies, normalized to SessionData. */
export function readSession(cookies: Cookies): SessionData {
	const payload = verifySession(cookies.get(SESSION_COOKIE));
	return {
		authenticated: payload?.auth === true,
		profileId: payload?.profileId ?? null,
		mode: payload?.mode ?? null
	};
}

/** Sign + write the session cookie (used for login and profile selection). */
export function setSession(cookies: Cookies, payload: SessionPayload): void {
	cookies.set(SESSION_COOKIE, signSession(payload), {
		httpOnly: true,
		sameSite: 'lax',
		path: '/',
		secure: process.env.NODE_ENV === 'production',
		maxAge: SESSION_MAX_AGE_SECONDS
	});
}

/** Clear the session cookie (logout). */
export function clearSession(cookies: Cookies): void {
	cookies.delete(SESSION_COOKIE, { path: '/' });
}

/**
 * Sanitize a caller-supplied `redirectTo` into a safe, same-origin relative path.
 * Rejects absolute URLs and protocol-relative (`//host`) values to avoid open redirects;
 * anything invalid falls back to `/`.
 */
export function safeRedirectTarget(value: string | null | undefined): string {
	if (!value) return '/';
	// Must be a single-slash-rooted path; reject `//evil.com`, `/\evil.com`, and any scheme.
	if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
	return value;
}

/**
 * Constant-time password check against the configured shared password.
 * Hashes both sides to equal-length buffers first so `timingSafeEqual` never sees (or
 * branches on) mismatched lengths — a naive length check before comparing is itself a leak.
 */
export function checkPassword(input: string): boolean {
	const inputHash = createHmac('sha256', config.sessionSecret).update(input).digest();
	const expectedHash = createHmac('sha256', config.sessionSecret)
		.update(config.appSharedPassword)
		.digest();
	return timingSafeEqual(inputHash, expectedHash);
}

// --- Minimal in-memory login throttle -------------------------------------------------
// Fine for a single Node process with 1-2 viewers; not shared across replicas, which is
// acceptable at this app's scale (see plan.md).

const MAX_FAILURES = 5;
const THROTTLE_WINDOW_MS = 30_000;

interface ThrottleEntry {
	failures: number;
	firstFailureAt: number;
	blockedUntil: number;
}

const throttleByIp = new Map<string, ThrottleEntry>();

export function isThrottled(ip: string): boolean {
	const entry = throttleByIp.get(ip);
	if (!entry) return false;
	if (entry.blockedUntil > Date.now()) return true;
	// Window expired without reaching the block threshold: reset.
	if (Date.now() - entry.firstFailureAt > THROTTLE_WINDOW_MS && entry.blockedUntil <= Date.now()) {
		throttleByIp.delete(ip);
	}
	return false;
}

export function registerFailure(ip: string): void {
	const now = Date.now();
	const entry = throttleByIp.get(ip);

	if (!entry || now - entry.firstFailureAt > THROTTLE_WINDOW_MS) {
		throttleByIp.set(ip, { failures: 1, firstFailureAt: now, blockedUntil: 0 });
		return;
	}

	entry.failures += 1;
	if (entry.failures >= MAX_FAILURES) {
		entry.blockedUntil = now + THROTTLE_WINDOW_MS;
	}
}

export function registerSuccess(ip: string): void {
	throttleByIp.delete(ip);
}
