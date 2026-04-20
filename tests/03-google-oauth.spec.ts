import { test } from "@playwright/test";

// Journey 3 — Google OAuth login.
//
// KNOWN GAP. Playwright driving the real Google login UI is too flaky
// for CI (bot detection, UI changes). This spec is a placeholder and
// lives here as a `test.skip` so the file count matches the plan.
//
// Manual reproduction, run quarterly:
//   1. Navigate to https://lum.id/auth/login in an incognito window.
//   2. Click "Continue with Google".
//   3. Walk through the Google consent screen with the test Google
//      account (lumid-e2e@gmail.com; creds in 1Password).
//   4. Expect to land on https://lum.id/account with a visible
//      "Welcome back, <name>" header.
//   5. Verify /api/v1/user returns role !== 'admin' and email matches.
//
// If we ever add a server-side OAuth provider stub (OAUTH_TEST_PROVIDER
// env flag on lumid-identity), unskip this and drive the stub instead.

test.skip("Google OAuth — quarterly manual smoke only", async () => {
	// intentionally empty — see doc comment above.
});
