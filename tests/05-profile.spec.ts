import { test, expect } from "@playwright/test";
import { createUser } from "../fixtures/test-user";

// Journey 5 — edit profile display name + upload an avatar.
//   * fresh user logs in
//   * visits /account/profile
//   * clicks Edit, changes the display name
//   * uploads an avatar (tiny 1x1 PNG as a buffer)
//   * saves, reloads, confirms the name persisted

test.describe("05 — profile edit", () => {
	let user: { email: string; password: string; username: string };

	test.beforeAll(async ({ baseURL }, testInfo) => {
		if (!process.env.E2E_GMAIL_APP_PASSWORD) testInfo.skip(true, "E2E_GMAIL_APP_PASSWORD not set");
		if (!process.env.E2E_INVITATION_CODE) testInfo.skip(true, "E2E_INVITATION_CODE not set");
		user = await createUser(baseURL!, { tag: `profile-${Date.now().toString(36)}` });
	});

	test("edits display name + uploads avatar; changes persist across reload", async ({ page }) => {
		// Log in
		await page.goto("/auth/login");
		await page.locator("#email").fill(user.email);
		await page.locator("#password").fill(user.password);
		await page.getByRole("button", { name: /sign in/i }).click();
		await expect(page).toHaveURL(/\/account(\/|$)/);

		await page.goto("/auth/account/profile");
		await expect(page.getByText(/display name/i)).toBeVisible();

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

		// The welcome header on the dashboard should now show the new
		// name too — prove it travels.
		await page.goto("/auth/account");
		await expect(page.getByText(/welcome back,/i)).toContainText(newName);
	});
});
