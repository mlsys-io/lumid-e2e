import { expect, type Page } from "@playwright/test";
import type { TestUser } from "./test-user";

/**
 * Log in through the real /auth/login form.
 *
 * The login page intermittently paints with zero inputs on a cold pod
 * (measured 2026-08-26, documented in specs 26/27). Retry the render a few
 * times before giving up — a single reload is not always enough.
 *
 * Shared by the fresh-user journey and the undergrad persona journey.
 */
export async function loginViaUi(page: Page, user: TestUser): Promise<void> {
	for (let attempt = 0; attempt < 3; attempt++) {
		await page.goto("/auth/login");
		if (await page.locator("#email").count().catch(() => 0)) break;
		await page.reload().catch(() => {});
	}
	await expect(page.locator("#email")).toBeVisible({ timeout: 30_000 });
	await page.locator("#email").fill(user.email);
	await page.locator("#password").fill(user.password);
	await page.getByRole("button", { name: /sign in/i }).click();
	await page.waitForURL(/\/auth\/redeem-invite|\/studio|\/dashboard|\/account(\/|$)/, {
		timeout: 30_000,
	});
}
