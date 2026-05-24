import { type Page, type BrowserContext } from "@playwright/test";

// Drives the admin persona through the login page and stashes the
// resulting lm_session cookie. Cached across tests via Playwright's
// storageState pattern — run once per worker, reused by every admin
// spec. Cheap (~2s) but skipping it matters when running multiple
// admin specs serially.

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL || "admin@lum.id";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

export function requireAdminCreds(): { email: string; password: string } {
	if (!ADMIN_PASSWORD) {
		throw new Error(
			"E2E_ADMIN_PASSWORD not set — see .env.example. " +
				"Create admin@lum.id via the normal /register flow, then " +
				"promote role=admin in the lumid-identity DB.",
		);
	}
	return { email: ADMIN_EMAIL, password: ADMIN_PASSWORD };
}

/**
 * Log in as admin@lum.id via the real login form. Caller should arrive
 * on `/account` (or their target admin route) after this returns.
 */
export async function loginAsAdmin(page: Page): Promise<void> {
	const { email, password } = requireAdminCreds();
	await page.goto("/auth/login");
	await page.getByLabel(/email/i).fill(email);
	await page.getByLabel(/password/i, { exact: false }).first().fill(password);
	await page.getByRole("button", { name: /sign in/i }).click();
	// Landing URL depends on role: admins → /dashboard, regular users
	// → /studio/today (post-S5 cutover). Accept either + the old
	// /account/* path for backward-compat. Whatever lands, the cookie
	// is set and bearer requests work.
	await page.waitForURL(/\/dashboard|\/studio|\/account(\/|$)/, { timeout: 15_000 });
}

/**
 * Serialize the current page's cookies + localStorage for reuse.
 * Specs that need a pre-authed admin context call this once in a
 * `beforeAll` and pass the resulting path to `context({storageState})`.
 */
export async function saveAdminStorage(
	context: BrowserContext,
	path: string,
): Promise<void> {
	await context.storageState({ path });
}
