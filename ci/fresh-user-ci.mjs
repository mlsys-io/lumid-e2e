#!/usr/bin/env node
// CI plumbing for the nightly fresh-user jobs (scorecard row 10).
//
// Until 2026-09-28 those jobs could not run a single test: no OTP source, no
// invitation code. Every test SKIPPED and the job still concluded success. This
// script is the part of the fix that lives outside the specs:
//
//   mint-invite  <note> [max_uses]   mint a single-purpose invitation code (1-day
//                                    TTL) with E2E_ADMIN_PAT; export it masked as
//                                    E2E_INVITATION_CODE and E2E_MINTED_INVITE.
//   revoke-invite                    revoke $E2E_MINTED_INVITE (idempotent).
//   assert-ran   <results.json> [min_passed]
//                                    FAIL unless >= min_passed tests passed and
//                                    none were skipped. The conclusion is not
//                                    evidence; the counts are.
//   sweep        <email-prefix> [min_age_min]
//                                    delete role=user accounts whose email starts
//                                    with <prefix> and are older than min_age_min
//                                    (default 60) — what a crashed run leaves.
//
// The admin credential is E2E_ADMIN_PAT: an ADMIN (not super_admin) account's
// PAT. It is never printed. Nothing here needs cluster access.

import { appendFileSync, readFileSync, existsSync } from "node:fs";

const BASE = process.env.BASE_URL || "https://lum.id";
const PAT = (process.env.E2E_ADMIN_PAT || "").trim();

function die(msg) {
	console.log(`::error::${msg}`);
	process.exit(1);
}

async function api(method, path, body) {
	if (!PAT) die("E2E_ADMIN_PAT is not set — the fresh-user jobs cannot mint an invite, read an OTP, or clean up");
	const r = await fetch(`${BASE}${path}`, {
		method,
		headers: { Authorization: `Bearer ${PAT}`, "Content-Type": "application/json" },
		body: body ? JSON.stringify(body) : undefined,
		signal: AbortSignal.timeout(20_000),
	});
	const text = await r.text();
	let json = null;
	try {
		json = JSON.parse(text);
	} catch {
		/* non-JSON error page */
	}
	return { status: r.status, ok: r.ok, json, text };
}

function exportEnv(name, value) {
	if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `${name}=${value}\n`);
}

async function mintInvite(note, maxUses) {
	const r = await api("POST", "/api/v1/admin/invitation-codes", {
		count: 1,
		max_uses: Number(maxUses || 1),
		ttl_days: 1,
		note: note || "e2e",
	});
	const code = r.json?.data?.codes?.[0]?.code;
	if (!r.ok || !code) die(`invitation mint failed: HTTP ${r.status} ${r.text.slice(0, 200)}`);
	console.log(`::add-mask::${code}`);
	exportEnv("E2E_INVITATION_CODE", code);
	exportEnv("E2E_MINTED_INVITE", code);
	console.log(`minted 1 invitation code (max_uses=${maxUses || 1}, ttl 1 day, note "${note}")`);
}

async function revokeInvite() {
	const code = process.env.E2E_MINTED_INVITE;
	if (!code) return console.log("no minted invite to revoke");
	const r = await api("DELETE", `/api/v1/admin/invitation-codes/${encodeURIComponent(code)}`);
	console.log(`revoke minted invite: HTTP ${r.status}`);
}

function assertRan(file, minPassed) {
	const min = Number(minPassed || 1);
	if (!existsSync(file)) die(`${file} missing — Playwright never wrote results, so nothing ran`);
	const s = JSON.parse(readFileSync(file, "utf8")).stats || {};
	const passed = s.expected ?? 0;
	const skipped = s.skipped ?? 0;
	const failed = s.unexpected ?? 0;
	const flaky = s.flaky ?? 0;
	const line = `tests: ${passed} passed, ${failed} failed, ${flaky} flaky, ${skipped} skipped`;
	console.log(line);
	if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n**${line}**\n`);
	if (skipped > 0) die(`${skipped} test(s) SKIPPED — a skipped journey is not a measured journey`);
	if (passed + flaky < min) die(`only ${passed + flaky} test(s) passed; need >= ${min}`);
}

async function sweep(prefix, minAgeMin) {
	if (!/^lumid-e2e-[a-z0-9-]+$/.test(prefix || "")) die(`refusing to sweep an unscoped prefix: "${prefix}"`);
	const cutoff = Date.now() - Number(minAgeMin || 60) * 60_000;
	const r = await api("GET", `/api/v1/admin/users?q=${encodeURIComponent(prefix)}&role=user&page_size=200`);
	if (!r.ok) die(`user search failed: HTTP ${r.status}`);
	const users = (r.json?.data?.users || []).filter(
		(u) =>
			String(u.email).toLowerCase().startsWith(prefix) &&
			u.role === "user" &&
			Date.parse(u.created_at) < cutoff,
	);
	let deleted = 0;
	for (const u of users) {
		const d = await api("DELETE", `/api/v1/admin/users/${u.id}`);
		if (d.ok) deleted++;
		else console.log(`::warning::could not delete ${u.email}: HTTP ${d.status}`);
	}
	console.log(`sweep ${prefix}*: ${deleted}/${users.length} stale account(s) deleted`);
}

const [cmd, a, b] = process.argv.slice(2);
switch (cmd) {
	case "mint-invite":
		await mintInvite(a, b);
		break;
	case "revoke-invite":
		await revokeInvite();
		break;
	case "assert-ran":
		assertRan(a, b);
		break;
	case "sweep":
		await sweep(a, b);
		break;
	default:
		die(`unknown command: ${cmd}`);
}
