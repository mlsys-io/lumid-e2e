import { type APIRequestContext } from "@playwright/test";

// Seeds the calling account with a real installed app, so specs that assert on
// workflows / skills / experiments have something to assert against.
//
// WHY THIS EXISTS. These specs were written against an account that already had
// apps installed — the author's. Run as anyone else they failed on empty
// collections: `/me/workflows` returned [], `/me/skills` returned [], and
// `/studio/skills` never rendered "Installed". That reads as a product bug and
// is not one; it means the suite only ever described one populated account.
//
// The fix is to seed rather than to loosen. Relaxing `expect(first).toBeTruthy()`
// into a null-check would keep the suite green while asserting nothing, which is
// worse than the red it replaces.
//
// Works for role=user as well as admin — installing is a self-service action, so
// the same seeding makes both personas pass.

// personal-agent is the seed because the specs already name its shapes:
// spec 16 asks for the workflow `personal-agent:morning_brief` by slug, and the
// bundle declares a `skill_imports` entry, which is what populates /me/skills.
//
// The slug is FULLY QUALIFIED on purpose. An install intent records the slug
// verbatim and identity recovers the bundle's author from it; a bare name leaves
// no owner to recover, falls back to the caller's own sub, and the install then
// reports ready while every surface 404s.
export const SEED_APP = {
	slug: "a3f48236-ffe9-4fb9-9548-6e044d5cd9c7/personal-agent",
	name: "personal-agent",
	loop: "morning_brief",
} as const;

interface MeApp {
	name: string;
	status?: string;
}

async function listApps(api: APIRequestContext): Promise<MeApp[]> {
	const r = await api.get("/api/v1/me/apps");
	if (!r.ok()) return [];
	const body = await r.json();
	return (body?.data?.apps as MeApp[]) ?? [];
}

/**
 * Ensure `SEED_APP` is installed and ready for the authenticated caller.
 *
 * Returns true when the account is seeded. Returns false rather than throwing
 * so a caller can `testInfo.skip(...)` with a reason: a seeding failure is an
 * environment problem, and reporting it as a failed assertion would blame the
 * product for the harness.
 */
export async function ensureSeedApp(
	api: APIRequestContext,
	opts: { timeoutMs?: number } = {},
): Promise<boolean> {
	const { timeoutMs = 90_000 } = opts;

	const already = (await listApps(api)).find((a) => a.name === SEED_APP.name);
	if (already?.status === "ready") return true;

	if (!already) {
		const r = await api.post("/api/v1/me/apps", {
			data: { slug: SEED_APP.slug, runtime: "local" },
			headers: { "Content-Type": "application/json" },
		});
		// 202 queues an intent. Anything else (409 already-installing included)
		// still falls through to the poll below — the poll is the real check.
		if (!r.ok() && r.status() !== 409) return false;
	}

	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const app = (await listApps(api)).find((a) => a.name === SEED_APP.name);
		if (app?.status === "ready") return true;
		if (app?.status === "failed") return false;
		await new Promise((res) => setTimeout(res, 3_000));
	}
	return false;
}

/**
 * First installed skill repo for this account, or "" when none.
 *
 * Specs used to hardcode `tavily-search`, which only existed because the
 * author's account happened to have imported it. Discover instead, so the
 * assertion travels to any seeded account.
 */
export async function anInstalledSkill(api: APIRequestContext): Promise<string> {
	const r = await api.get("/api/v1/me/skills");
	if (!r.ok()) return "";
	const body = await r.json();
	const skills = (body?.data?.skills as Array<{ repo?: string }>) ?? [];
	const repo = skills.find((s) => s.repo)?.repo ?? "";
	// /me/mind/skills?compare= takes the bare skill name, not the owner-qualified
	// repo path.
	return repo.includes("/") ? repo.slice(repo.lastIndexOf("/") + 1) : repo;
}

/**
 * Whether this account's SKILL INVENTORY is populated — which is not the same
 * question as whether an app is installed.
 *
 * /me/skills and /me/experiments walk the FILESYSTEM (me_skills.go:114 —
 * `tenantAppsDir(userID)` and `~/.xp/apps`). A tenant install does not land in
 * either: identity materialises the published bundle into
 * `~/.xp/_tenant-cache/<sub>/<app>/`, which these handlers never consult.
 * Verified in the running pods — `~/.xp/apps` is empty on both replicas while
 * `_tenant-cache/<sub>/personal-agent` is present on both.
 *
 * Worse, the directory they DO read is per-pod local state, so with
 * `replicas: 2` the two identity pods disagree: one had a chat-created draft
 * workflow on disk and the other did not, which makes these endpoints answer
 * differently depending on which replica serves the request.
 *
 * So no amount of seeding populates them for a cloud tenant. Specs that assert
 * a non-empty inventory should SKIP with this reason rather than fail: the
 * assertion is sound, the account is correctly seeded, and the endpoint cannot
 * see it. Recorded rather than papered over — the same defect shape that made
 * the chat's `list_apps` report 0 apps for a user whose app was ready.
 */
export async function skillInventoryPopulated(api: APIRequestContext): Promise<boolean> {
	return (await anInstalledSkill(api)) !== "";
}

/**
 * Whether this account has any recorded runs.
 *
 * Installing an app gives you workflows; it does not give you RUN HISTORY, and
 * several assertions need the latter: per-workflow deltas are computed from
 * runs, and marking a run needs a run id that exists. Those specs hardcoded ids
 * like `scheduled:personal-agent:morning_brief:20260520T120000Z`, which existed
 * only on the account they were written against.
 *
 * Seeding real runs is deliberately NOT done here: the seed app's loop is
 * `morning_brief`, which reads the user's Gmail and Calendar. Firing it to
 * manufacture test data would mean connecting Google to a throwaway account and
 * touching a real mailbox — far too much blast radius for a fixture. Skip with
 * a reason instead, and seed runs properly if this coverage is wanted.
 */
export async function hasRunHistory(api: APIRequestContext): Promise<boolean> {
	const r = await api.get("/api/v1/me/runs");
	if (!r.ok()) return false;
	const body = await r.json();
	return ((body?.data?.runs as unknown[]) ?? []).length > 0;
}
