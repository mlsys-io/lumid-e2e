import { test, expect } from "@playwright/test";
import { createUser } from "../fixtures/test-user";
import { localOtpEnabled } from "../fixtures/otp-redis";

// Where a successful sign-in lands. Role-dependent since the S5 cutover:
// admins go to /dashboard, regular users to /studio; /account/* is the older
// path, kept so this still passes wherever it survives. Same set
// fixtures/admin-session.ts already waits on — these specs were written when
// /account was the only answer and asserted it literally, which is why a
// role=user landing on /studio read as a failure.
const POST_LOGIN_URL = /\/dashboard|\/studio|\/account(\/|$)/;


// Journey 5 — edit profile display name + upload an avatar.
//   * fresh user logs in
//   * visits /account/profile
//   * clicks Edit, changes the display name
//   * uploads an avatar (tiny 1x1 PNG as a buffer)
//   * saves, reloads, confirms the name persisted

test.describe("05 — profile edit", () => {
	let user: { email: string; password: string; username: string };

	test.beforeAll(async ({ baseURL }, testInfo) => {
		if (!localOtpEnabled() && !process.env.E2E_GMAIL_APP_PASSWORD) {
			testInfo.skip(true, "no OTP source: set E2E_GMAIL_APP_PASSWORD, or CI_E2E_LOCAL_OTP=1 for the Redis backdoor");
		}
		if (!process.env.E2E_INVITATION_CODE) testInfo.skip(true, "E2E_INVITATION_CODE not set");
		user = await createUser(baseURL!, { tag: `profile-${Date.now().toString(36)}` });
	});

	test("edits display name + uploads avatar; changes persist across reload", async ({ page }) => {
		// Log in
		await page.goto("/auth/login");
		await page.locator("#email").fill(user.email);
		await page.locator("#password").fill(user.password);
		await page.getByRole("button", { name: /sign in/i }).click();
		await expect(page).toHaveURL(POST_LOGIN_URL);

		await page.goto("/auth/account/profile");
		// Exact + label-scoped: /display name/i also matches two descriptive
		// paragraphs on this page ("Your display name and avatar across every
		// Lumid app..."), which is a strict-mode violation rather than a
		// missing element -- the page renders fine.
		await expect(page.getByText("Display name", { exact: true }).first()).toBeVisible();

		const newName = `e2e renamed ${Date.now().toString(36).slice(-4)}`;

		await page.getByRole("button", { name: /^edit$/i }).click();

		// Display name field
		const nameField = page.locator("#uname");
		await nameField.fill(newName);

		// Avatar upload — a minimal valid PNG (1x1 transparent).
		const tinyPng = Buffer.from(
			"89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D49444154789C63F80F000001010100" +
				"5BE2E2CF0000000049454E44AE426082",
			"hex",
		);
		await page.locator('input[type="file"]').setInputFiles({
			name: "avatar.png",
			mimeType: "image/png",
			buffer: tinyPng,
		});

		await page.getByRole("button", { name: /save/i }).click();

		// The page reloads itself on save (see profile.tsx onSaveSuccess).
		await page.waitForLoadState("networkidle");

		// Reload to prove persistence.
		await page.goto("/auth/account/profile");
		await expect(page.locator("#uname")).toHaveValue(newName);

		// Prove it travels beyond the form that set it. The "Welcome back, <name>"
		// dashboard header this used to assert no longer exists — Studio greets
		// "Good morning/afternoon/evening" with no name in it. The name does still
		// surface, in the sidebar user-menu button (username + email), so assert
		// there: same claim, on a surface that exists.
		await page.goto("/studio");
		await expect(
			page.getByRole("button", { name: new RegExp(user.email, "i") }).first(),
		).toContainText(newName, { timeout: 15_000 });
	});
});
