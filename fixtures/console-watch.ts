import { type Page, type ConsoleMessage } from "@playwright/test";

// Watch a page's console and collect errors worth failing on.
//
// This is the highest-yield assertion in the suite and it is worth saying why,
// because it looks like boilerplate. On 2026-08-27 it was the ONLY thing in the
// estate that noticed QuantArena's authenticated API had been returning 401 to
// every request for three days: qa-backend's LUMID_IDENTITY_URL still pointed
// at host.docker.internal, a pre-UKS docker address that does not resolve in
// Kubernetes, so every token introspection failed at DNS. Argo read Synced,
// the pod read Healthy, no tile went red, no alert fired. A browser test caught
// it because it drove the page a user drives and listened to what the page
// complained about.
//
// The lesson generalises: a page that RENDERS is not a page that WORKS. Assert
// on what it says went wrong, not only on what it managed to draw.
//
// Usage:
//   const errors = watchConsole(page);
//   await page.goto(...);
//   expect(errors(), errors().join("\n")).toEqual([]);

// Noisy-but-harmless patterns from third-party scripts and retired embeds.
//
// KEEP THIS LIST SHORT AND JUSTIFIED. Every entry is a class of breakage the
// suite can no longer see. `.*404` in particular already hides a real defect:
// /studio/super-admin's cycle-artifact tiles 404 permanently, because that
// handler reads ~/.xp off identity's own filesystem and identity mounts only
// signing-keys. That is a genuine bug rendering as a permanent em-dash, and
// this allowlist is why no test says so.
export const CONSOLE_ALLOW: RegExp[] = [
	/favicon/i,
	/preload .* unused/i,
	/Download the React DevTools/i,
	/WebSocket connection .* failed/i, // live ws may fail in a test env
	/grafana/i, // 9 dead embeds; the /grafana route was deleted 2026-07-04
	/Failed to load resource:.*404/i, // optional assets — see caveat above
	/Mixed Content/i, // legacy iframe edges
];

/**
 * Start collecting console errors. Returns a getter for what has accumulated.
 * Errors matching CONSOLE_ALLOW are dropped.
 */
export function watchConsole(page: Page, extraAllow: RegExp[] = []): () => string[] {
	const allow = [...CONSOLE_ALLOW, ...extraAllow];
	const errors: string[] = [];
	page.on("console", (msg: ConsoleMessage) => {
		if (msg.type() !== "error") return;
		const text = msg.text();
		if (allow.some((p) => p.test(text))) return;
		errors.push(text);
	});
	return () => errors;
}

/**
 * Also surface failed requests — a fetch that never resolves emits no console
 * error in some browsers, so the console alone can miss a dead upstream.
 */
export function watchFailedRequests(page: Page, ignore: RegExp[] = []): () => string[] {
	const failures: string[] = [];
	page.on("requestfailed", (req) => {
		const url = req.url();
		if (ignore.some((p) => p.test(url))) return;
		failures.push(`${req.method()} ${url} — ${req.failure()?.errorText ?? "failed"}`);
	});
	return () => failures;
}
