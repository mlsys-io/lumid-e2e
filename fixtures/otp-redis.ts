// Redis-OTP fixture — local-only bypass for the Gmail dependency.
//
// The identity service writes 6-digit OTPs to Redis at
// `identity:otp:<email>` (DB 3) with a 10-minute TTL. From the host
// we can `docker exec` into the Redis container and read them
// directly, which lets the long auto-quant spec run end-to-end
// without an active mailbox subscription.
//
// Gated by CI_E2E_LOCAL_OTP=1. CI never sets this — nightly cron
// uses the real mailbox path so the email round-trip is exercised
// at least once a day. Use locally to skip the OTP-poll latency
// (~10-30s per user) and the Gmail-app-password requirement.

import { spawnSync } from "node:child_process";

export function localOtpEnabled(): boolean {
	return process.env.CI_E2E_LOCAL_OTP === "1";
}

interface RedisCreds {
	password: string;
	host: string; // bridge IP visible from the host
}

let _cachedCreds: RedisCreds | null = null;

// Probe the running identity container for its REDIS_PASSWORD env.
// Cached because spawning docker exec on every read adds up.
function loadCreds(): RedisCreds {
	if (_cachedCreds) return _cachedCreds;
	const r = spawnSync(
		"docker",
		["exec", process.env.LUMID_IDENTITY_CONTAINER || "lumid-identity", "env"],
		{ encoding: "utf8", timeout: 5000 },
	);
	if (r.status !== 0) {
		throw new Error(
			`Could not read identity env (docker exec status=${r.status}). ` +
			`Set CI_E2E_LOCAL_OTP=0 to fall back to mailbox, or LUMID_IDENTITY_CONTAINER=<name>.`,
		);
	}
	const passLine = r.stdout.split("\n").find((l) => l.startsWith("REDIS_PASSWORD="));
	if (!passLine) throw new Error("identity container has no REDIS_PASSWORD");
	const password = passLine.slice("REDIS_PASSWORD=".length).trim();
	const host = process.env.LUMID_OTP_REDIS_HOST || "172.17.0.1";
	_cachedCreds = { password, host };
	return _cachedCreds;
}

/**
 * Poll Redis for the OTP belonging to `email`. Returns the 6-digit code
 * as a string. Throws if not present within `timeoutMs`.
 *
 * Identity writes the key with a 10-min TTL, so the polling loop is
 * generous — it's the test cost that matters, not the TTL.
 */
export async function readOtpFromRedis(
	email: string,
	opts: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<string> {
	const { timeoutMs = 30_000, pollIntervalMs = 250 } = opts;
	const { password, host } = loadCreds();
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const r = spawnSync(
			"docker",
			[
				"run", "--rm", "--network=host",
				"redis:7-alpine",
				"redis-cli", "-h", host, "-p", "6379",
				"-a", password, "--no-auth-warning",
				"-n", "3",
				"GET", `identity:otp:${email}`,
			],
			{ encoding: "utf8", timeout: 8_000 },
		);
		const out = (r.stdout || "").trim();
		if (out && /^\d{6}$/.test(out)) return out;
		await new Promise((res) => setTimeout(res, pollIntervalMs));
	}
	throw new Error(`OTP for ${email} not found in Redis within ${timeoutMs}ms`);
}
