// Redis-OTP fixture — reads the signup OTP straight out of identity's
// Redis instead of waiting on a Gmail round-trip.
//
// Identity writes 6-digit OTPs to `identity:otp:<email>` in Redis DB 3
// with a 10-minute TTL (REDIS_ADDR=redis-trading:6379). That Redis
// requires AUTH; both transports resolve the password server-side
// rather than carrying it here. Two transports:
//
//   docker  — the original local-compose shape (docker exec / docker run)
//   kubectl — prod/UKS: exec into the redis-trading pod
//   api     — CI: identity's admin-gated GET /api/v1/admin/e2e/signup-otp,
//             which serves ONLY e2e test addresses (lumid-e2e-…@yao.lu).
//             Needs an admin PAT (E2E_ADMIN_PAT, or ~/.lumid/admin.pat) and
//             no cluster access at all — the only transport a GitHub-hosted
//             runner can use. Added for scorecard row 10 (2026-09-28).
//
// Chosen by LUMID_OTP_TRANSPORT (default: "kubectl" when KUBECONFIG is
// set or the docker binary is absent, else "docker").
//
// Gated by CI_E2E_LOCAL_OTP=1. Locally it skips the OTP-poll latency
// (~10-30s per user) and the Gmail-app-password requirement. CI's nightly
// fresh-user jobs set it with LUMID_OTP_TRANSPORT=api: no test mailbox was
// ever provisioned, and without an OTP source those jobs skipped every test
// and still concluded success (found 2026-09-27).
//
// NOTE this reads a live credential out of a production Redis. It is
// deliberately opt-in and deliberately narrow: one GET, one key, keyed
// by an address this suite just minted for itself.

import { spawnSync } from "node:child_process";

import { existsSync, readFileSync } from "node:fs";
export function localOtpEnabled(): boolean {
	return process.env.CI_E2E_LOCAL_OTP === "1";
}

type Transport = "docker" | "kubectl" | "api";

function transport(): Transport {
	const t = process.env.LUMID_OTP_TRANSPORT;
	if (t === "docker" || t === "kubectl" || t === "api") return t;
	if (process.env.KUBECONFIG) return "kubectl";
	// Probe for the identity CONTAINER, not the docker daemon.
	//
	// This used to run `docker version`, which answers "is docker installed?"
	// — a different question from the one that matters. On any box with docker
	// present but identity running in k8s (i.e. every non-compose environment),
	// it selected the docker transport and then died in loadDockerCreds with
	// "Could not read identity env (docker exec status=1)". That is a fixture
	// failure, so the specs FAILED rather than skipping, and seven of them
	// — 01, 02, 05, 06, 08, 22, 23, including the whole student walkthrough —
	// were red for months for a reason that had nothing to do with the product.
	// Measured 2026-09-04: all seven pass once the transport resolves.
	const probe = spawnSync(
		"docker",
		["exec", process.env.LUMID_IDENTITY_CONTAINER || "lumid-identity", "true"],
		{ encoding: "utf8", timeout: 5_000 },
	);
	return probe.status === 0 ? "docker" : "kubectl";
}

interface RedisCreds {
	password: string; // "" when the server takes no AUTH
	host: string;
}

let _cachedCreds: RedisCreds | null = null;

// Probe the running identity container for its REDIS_PASSWORD env.
// Cached because spawning docker exec on every read adds up.
function loadDockerCreds(): RedisCreds {
	if (_cachedCreds) return _cachedCreds;
	const r = spawnSync(
		"docker",
		["exec", process.env.LUMID_IDENTITY_CONTAINER || "lumid-identity", "env"],
		{ encoding: "utf8", timeout: 5_000 },
	);
	if (r.status !== 0) {
		throw new Error(
			`Could not read identity env (docker exec status=${r.status}). ` +
			`Set CI_E2E_LOCAL_OTP=0 to fall back to mailbox, or LUMID_IDENTITY_CONTAINER=<name>.`,
		);
	}
	const passLine = r.stdout.split("\n").find((l) => l.startsWith("REDIS_PASSWORD="));
	if (!passLine) throw new Error("identity container has no REDIS_PASSWORD");
	_cachedCreds = {
		password: passLine.slice("REDIS_PASSWORD=".length).trim(),
		host: process.env.LUMID_OTP_REDIS_HOST || "172.17.0.1",
	};
	return _cachedCreds;
}

// Resolve a kubeconfig for the kubectl transport.
//
// Without this, `kubectl` falls back to ~/.kube/config — which does not exist
// on the operator box, where every context is a named file (lumid-prod2.yaml,
// home-k3s.yaml). The transport then failed with
// `dial tcp 127.0.0.1:8080: connect: connection refused`, i.e. kubectl talking
// to the default in-cluster address because it had no context at all. That is
// a confusing way to say "no kubeconfig", and it made the fixture depend on an
// ambient env var nothing declared.
//
// LUMID_OTP_KUBECONFIG overrides; otherwise use KUBECONFIG as-is, then the
// standard ~/.kube/config, then the estate's canonical cloud context.
function kubeEnv(): NodeJS.ProcessEnv {
	if (process.env.KUBECONFIG) return process.env;
	const home = process.env.HOME || "";
	const candidates = [
		process.env.LUMID_OTP_KUBECONFIG,
		home && `${home}/.kube/config`,
		home && `${home}/.kube/lumid-prod2.yaml`,
	].filter(Boolean) as string[];
	for (const c of candidates) {
		if (existsSync(c)) return { ...process.env, KUBECONFIG: c };
	}
	return process.env;
}

function redisArgs(db: string, key: string, password: string): string[] {
	const a = ["redis-cli"];
	if (password) a.push("-a", password, "--no-auth-warning");
	a.push("-n", db, "GET", key);
	return a;
}

// One read against the in-cluster Redis, executed inside the
// redis-trading pod itself — nothing is port-forwarded and no
// credential crosses the network.
function kubectlGet(key: string, db: string): { out: string; status: number | null; err: string } {
	const ns = process.env.LUMID_OTP_NAMESPACE || "lumid";
	const target = process.env.LUMID_OTP_REDIS_DEPLOY || "deploy/redis-trading";
	// The in-cluster Redis DOES require AUTH — its own container runs
	// `redis-server --requirepass "$REDIS_PASSWORD"`. Resolve that password
	// INSIDE the pod from the pod's own env rather than reading the Secret
	// out to this process: the value never crosses the network, never lands
	// in a shell history, and never reaches a Playwright trace. Set
	// LUMID_OTP_REDIS_PASSWORD only for a Redis configured some other way.
	const override = process.env.LUMID_OTP_REDIS_PASSWORD || "";
	const script = override
		? 'exec redis-cli -a "$1" --no-auth-warning -n "$2" GET "$3"'
		: 'exec redis-cli -a "$REDIS_PASSWORD" --no-auth-warning -n "$2" GET "$3"';
	const r = spawnSync(
		"kubectl",
		["-n", ns, "exec", target, "--", "sh", "-c", script, "_", override, db, key],
		{ encoding: "utf8", timeout: 15_000, env: kubeEnv() },
	);
	return { out: (r.stdout || "").trim(), status: r.status, err: (r.stderr || "").trim() };
}

function dockerGet(key: string, db: string): { out: string; status: number | null; err: string } {
	const { password, host } = loadDockerCreds();
	const [cli, ...rest] = redisArgs(db, key, password);
	const r = spawnSync(
		"docker",
		["run", "--rm", "--network=host", "redis:7-alpine", cli, "-h", host, "-p", "6379", ...rest],
		{ encoding: "utf8", timeout: 8_000 },
	);
	return { out: (r.stdout || "").trim(), status: r.status, err: (r.stderr || "").trim() };
}

function adminPat(): string {
	if (process.env.E2E_ADMIN_PAT) return process.env.E2E_ADMIN_PAT.trim();
	const f = `${process.env.HOME || ""}/.lumid/admin.pat`;
	try {
		return existsSync(f) ? readFileSync(f, "utf8").trim() : "";
	} catch {
		return "";
	}
}

// One read through identity's e2e-only OTP route. Maps onto the same
// {out,status,err} shape as the Redis transports: status 0 + empty out means
// "not written yet" (the route answers 200 with code:null), anything else is a
// refusal, surfaced verbatim so a 403/404 is never mis-reported as a missing
// OTP.
async function apiGet(email: string): Promise<{ out: string; status: number | null; err: string }> {
	const base = process.env.BASE_URL || "https://lum.id";
	const pat = adminPat();
	if (!pat) return { out: "", status: 1, err: "no admin PAT (E2E_ADMIN_PAT or ~/.lumid/admin.pat)" };
	try {
		const r = await fetch(`${base}/api/v1/admin/e2e/signup-otp?email=${encodeURIComponent(email)}`, {
			headers: { Authorization: `Bearer ${pat}` },
			signal: AbortSignal.timeout(15_000),
		});
		const body = await r.text();
		if (!r.ok) {
			// 401/403/404 are answers, not blips: the server said no.
			return { out: `DENIED HTTP ${r.status}: ${body.slice(0, 200)}`, status: 0, err: "" };
		}
		const code = JSON.parse(body)?.data?.code;
		return { out: typeof code === "string" ? code : "", status: 0, err: "" };
	} catch (e) {
		return { out: "", status: 1, err: String(e) };
	}
}

// redis-cli reports a REFUSED command by printing the error reply to
// STDOUT and exiting 0, so exit status alone cannot tell "the server said
// no" from "the key is not there yet". Without this check a NOAUTH burns
// the entire timeout and is then reported as a missing OTP — the exact
// mis-diagnosis this fixture exists to prevent. (It did exactly that once.)
const REDIS_REFUSAL = /^(NOAUTH|WRONGPASS|NOPERM|DENIED|ERR|LOADING|MASTERDOWN|READONLY)\b/;

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
	const { timeoutMs = 30_000, pollIntervalMs = 500 } = opts;
	const db = process.env.LUMID_OTP_REDIS_DB || "3";
	const key = `identity:otp:${email}`;
	const via = transport();
	const deadline = Date.now() + timeoutMs;
	let lastErr = "";
	let consecutiveTransportFailures = 0;
	while (Date.now() < deadline) {
		const r =
			via === "api" ? await apiGet(email) : via === "kubectl" ? kubectlGet(key, db) : dockerGet(key, db);
		if (/^\d{6}$/.test(r.out)) return r.out;
		// The server answered and said no. Retrying cannot help, so fail now
		// with what it actually said.
		if (REDIS_REFUSAL.test(r.out)) {
			throw new Error(
				`The OTP source refused the read (${via}${via === "api" ? "" : `, db ${db}`}): ${r.out}. ` +
				"This is an auth/permission failure, not a missing OTP.",
			);
		}
		// A transport-level failure (no kubeconfig, RBAC, wrong deploy) is
		// NOT a missing key either. One blip can be transient; three in a row
		// is a broken setup, so stop rather than burn the whole timeout and
		// then blame the OTP.
		if (r.status !== 0) {
			lastErr = r.err || `exit status ${r.status}`;
			if (++consecutiveTransportFailures >= 3) {
				throw new Error(
					`Cannot reach Redis (${via}, db ${db}) — 3 consecutive failures. ` +
					`Last error: ${lastErr}`,
				);
			}
		} else {
			consecutiveTransportFailures = 0;
		}
		await new Promise((res) => setTimeout(res, pollIntervalMs));
	}
	throw new Error(
		`OTP for ${email} not found in Redis (${via}, db ${db}) within ${timeoutMs}ms` +
		(lastErr ? ` — last transport error: ${lastErr}` : ""),
	);
}
