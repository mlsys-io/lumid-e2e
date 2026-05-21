import { request, type APIRequestContext } from "@playwright/test";
import { taggedAddress, waitForEmail, extractOtp } from "./mailbox";
import { localOtpEnabled, readOtpFromRedis } from "./otp-redis";

// Provisions a fresh test user via the REST API. Used by specs that
// need a brand-new account (e.g. login spec, logout spec, password-
// change spec). Signup spec itself drives the UI directly and does
// NOT use this fixture.
//
// Each call uses a unique `+subaddress` tag so concurrent runs don't
// race on OTPs. The created user is left in the DB; nightly cron
// (/proj/infra/cron/e2e-teardown.sh) removes anything older than 24h.

export interface TestUser {
	email: string;
	password: string;
	username: string;
}

function rand(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Register a new user via REST. Walks the full 3-step flow:
 *   1. POST /api/v1/send-verification-code
 *   2. Poll Gmail for OTP
 *   3. POST /api/v1/register with the OTP
 *
 * Returns {email, password, username} so the test can log in with it.
 */
export async function createUser(
	baseURL: string,
	opts: { tag?: string; password?: string; username?: string; invitationCode?: string } = {},
): Promise<TestUser> {
	const tag = opts.tag || `signup-${rand()}`;
	// CI_E2E_LOCAL_OTP=1 takes the Redis backdoor path — uses a synthetic
	// non-Gmail address (no delivery needed) and reads the OTP straight
	// out of identity's Redis. Useful for local validation without
	// holding a Gmail app password. Default path (mailbox) still wins in
	// CI so the email round-trip stays under test.
	const useLocalOtp = localOtpEnabled();
	const email = useLocalOtp
		? `lumid-e2e-${tag}@yao.lu`
		: taggedAddress(tag);
	const password = opts.password || `Lumid-e2e-${rand()}!`;
	const username = opts.username || `e2e-${tag}`;

	const api = await request.newContext({ baseURL });
	try {
		// 1. Request OTP
		const otpReq = await api.post("/api/v1/send-verification-code", {
			data: { email },
			headers: { "Content-Type": "application/json" },
		});
		if (!otpReq.ok()) {
			throw new Error(`send-verification-code ${otpReq.status()}: ${await otpReq.text()}`);
		}

		// 2. Read OTP — either from Redis (local backdoor) or from Gmail.
		let code: string;
		if (useLocalOtp) {
			code = await readOtpFromRedis(email, { timeoutMs: 30_000 });
		} else {
			const mail = await waitForEmail(email, { timeoutMs: 120_000 });
			code = extractOtp(mail.html, mail.text);
		}

		// 3. Register. Invitation code (optional) lets specs that need
		//    a user with a redeemed code pass it inline rather than
		//    walking the /auth/redeem-invite UI after the fact.
		const reg = await api.post("/api/v1/register", {
			data: {
				email,
				password,
				name: username,
				verification_code: code,
				...(opts.invitationCode ? { invitation_code: opts.invitationCode } : {}),
			},
			headers: { "Content-Type": "application/json" },
		});
		if (!reg.ok()) {
			throw new Error(`register ${reg.status()}: ${await reg.text()}`);
		}
	} finally {
		await api.dispose();
	}

	return { email, password, username };
}

/**
 * Helper to log in via REST + capture the lm_session cookie. Useful
 * for specs that want to arrive on /account already authed without
 * driving the login page. Browser specs use `page.goto('/login')`
 * and fill the form normally — use this only when the test's subject
 * is something OTHER than the login UI.
 */
export async function loginViaApi(
	api: APIRequestContext,
	email: string,
	password: string,
): Promise<void> {
	const r = await api.post("/api/v1/login", {
		data: { email, password },
		headers: { "Content-Type": "application/json" },
	});
	if (!r.ok()) {
		throw new Error(`login ${r.status()}: ${await r.text()}`);
	}
}
