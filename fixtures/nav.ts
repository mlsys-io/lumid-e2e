import { type Page } from "@playwright/test";

/**
 * Navigate to a URL that immediately client-side redirects.
 *
 * Studio is full of these: /studio/workflows, /studio/mind, /studio/a/<app> and
 * the retired /app/* family are all `<Navigate>` elements, and /studio/apps
 * self-redirects to /studio/apps/<app>. The SPA replaces the URL before "load"
 * fires, so a plain `page.goto()` races the redirect.
 *
 * Chromium tolerates that and Firefox does not — it rejects with
 * "Navigation to X is interrupted by another navigation to Y", or occasionally
 * NS_ERROR_FAILURE. Both are the redirect WORKING, reported as a navigation
 * error, which is why these read as browser-specific flake rather than the
 * deterministic difference they are.
 *
 * `waitUntil: "commit"` returns as soon as the navigation commits instead of
 * waiting for load, and the catch absorbs the interruption when the redirect
 * wins the race anyway. Assert on the final URL afterwards — that is the
 * behaviour under test, not which navigation event fired.
 */
export async function gotoRedirect(page: Page, url: string): Promise<void> {
	await page.goto(url, { waitUntil: "commit" }).catch(() => {
		/* the redirect fired first — assert on the resulting URL instead */
	});
}
