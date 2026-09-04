import { test } from "@playwright/test";
import { gotoRedirect } from "../fixtures/nav";

// NOT A TEST — a doc-image GENERATOR. It drives a real model turn until the
// reply contains an inline SVG, then screenshots it into
// public/docs/img/first-run-chat-analytics.png. It asserts nothing.
//
// Tagged @shot and excluded from the default run. Left untagged it cost the
// suite TEN of its eighteen minutes (a 600s wait on a model turn) and reported
// a red "failure" for a screenshot nobody had asked it to take.
//
// REQUIRES super_admin. The prompt reads `lqt_mailbox_read(endpoint=results)`,
// a PLATFORM-WIDE feed carrying every tenant's rows; identity v0.5.321 gated
// those to operators (rows have no tenant column, so an admin reading them sees
// everyone). E2E_ADMIN_EMAIL is role=admin, so the read is now correctly
// refused, the model has no data, no chart is drawn, and the wait runs to its
// full 600s. That is the gate working, not a regression — but it means this
// generator needs an operator account, or a tenant-scoped data source.
//
// Run deliberately:  npx playwright test --grep @shot tests/99-shot-analytics.spec.ts
test("@shot screenshot: chart rendered inside the chat bubble", async ({ page, baseURL }) => {
	// SKIP by default, in any invocation — do not rely on remembering a grep
	// flag. Skipping (not failing) is the point: a generator that reports RED
	// when nobody asked for a screenshot is exactly the noise that taught
	// people to ignore this suite's colour, which is how seven genuinely
	// broken specs sat unnoticed behind the OTP gate.
	test.skip(!process.env.SHOT, "doc-image generator — set SHOT=1 to run");
	test.setTimeout(700_000);
	await page.goto(`${baseURL}/auth/login`);
	await page.evaluate(
		async ([b, e, p]) => {
			await fetch(`${b}/api/v1/login`, {
				method: "POST", headers: { "Content-Type": "application/json" },
				credentials: "include",
				body: JSON.stringify({ email: e, password: p }),
			});
		},
		[baseURL!, process.env.E2E_ADMIN_EMAIL!, process.env.E2E_ADMIN_PASSWORD!] as const,
	);
	await gotoRedirect(page, "/studio");
	const box = page.getByPlaceholder("Ask anything…").first();
	await box.waitFor({ timeout: 60_000 });
	await box.fill(
		"Read my LQT backtest results with lqt_mailbox_read (endpoint=results). " +
		"Then draw a bar chart of how many results are real on all three honesty " +
		"axes vs how many are not, and render it INLINE IN YOUR REPLY as a markdown " +
		"image using an SVG data URI, exactly like: " +
		"![chart](data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' " +
		"width='520' height='260'>...</svg>) . Use rgb() colours, never # hex, and " +
		"single quotes inside the SVG, so the data URI stays valid. Put the counts " +
		"as text labels on the bars. Do not use save_artifact.",
	);
	await box.press("Enter");

	// Wait for an actual rendered image inside the transcript.
	const chart = page.locator('img[src^="data:image/svg"]').first();
	await chart.waitFor({ state: "visible", timeout: 600_000 });
	await page.waitForTimeout(4000);
	await chart.scrollIntoViewIfNeeded();
	await page.waitForTimeout(2500);
	console.log("inline chart rendered");
	await page.screenshot({
		path: "/proj/lumid_ui/public/docs/img/first-run-chat-analytics.png",
		clip: { x: 224, y: 56, width: 1056, height: 620 },
	});
});
