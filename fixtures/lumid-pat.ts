import { type Page, type APIRequestContext, request } from "@playwright/test";

/**
 * Drives the `/dashboard/tokens` UI to mint a fresh `lm_pat_live_*`
 * PAT for the currently-logged-in user. Captures the token from the
 * modal that appears after clicking "Create" — the token is shown
 * exactly once, so the test must read it eagerly.
 *
 * Two flavors:
 *   - mintPatViaPage(page, name, scope)  — for specs that already
 *     have a logged-in browser context. Drives the dashboard.
 *   - mintPatViaApi(api, name, scope)    — for specs that came in
 *     via loginViaApi() and only have an APIRequestContext. Hits
 *     the same `/api/v1/tokens` endpoint the UI calls under the
 *     hood.
 *
 * Both raise on failure with a descriptive message including the
 * HTTP status / DOM snapshot for the case that breaks.
 */

export interface LumidPatToken {
	pat: string;          // "lm_pat_live_..." (64-char suffix)
	tokenId: string;      // server-side id (returned by REST)
	scope: string;        // "Full access" | "read" | etc.
	name: string;
}

const PAT_REGEX = /\b(lm_pat_live_[A-Za-z0-9_-]{40,80})\b/;

/**
 * Drive the dashboard UI to mint a PAT. The caller must be logged in
 * (the page's auth cookie must be valid). Use after a fresh signup
 * via createUser() + loginViaApi() + page.context().addCookies(),
 * OR after a UI-driven login in the same browser context.
 */
export async function mintPatViaPage(
	page: Page,
	opts: { name?: string; scope?: "Full access" | "Read only" } = {},
): Promise<LumidPatToken> {
	const name = opts.name || `e2e-${Date.now().toString(36)}`;
	const scope = opts.scope || "Full access";

	await page.goto("/dashboard/tokens");
	// Wait for the "New token" / "Create" button — the dashboard's
	// tokens panel is identifiable by an empty-state message OR by
	// the "Create" CTA button. Either should be in DOM.
	const createBtn = page.getByRole("button", { name: /new token|create token|^create$/i });
	await createBtn.first().waitFor({ timeout: 15_000 });
	await createBtn.first().click();

	// Modal form: name + scope + Confirm
	await page.locator('input[name="name"], input#token-name, input[placeholder*="name" i]').first().fill(name);
	// Scope selector — radio or select; tolerate either shape
	const scopeRadio = page.getByRole("radio", { name: scope });
	if (await scopeRadio.count()) {
		await scopeRadio.first().check();
	}
	const confirmBtn = page.getByRole("button", { name: /confirm|create token|create$/i });
	await confirmBtn.first().click();

	// The PAT is rendered exactly once after creation. Look for any
	// element containing the lm_pat_live_ prefix. The dashboard
	// usually surfaces it inside an <input readonly> or a <code> tag.
	const patNode = await page.waitForSelector(
		"input[readonly], code, pre",
		{ state: "attached", timeout: 10_000 },
	);
	// Scan textContent + value across candidate nodes for the PAT.
	const candidates = await page.locator("input[readonly], code, pre").all();
	let pat: string | null = null;
	for (const c of candidates) {
		const v = (await c.inputValue().catch(() => null)) || (await c.textContent());
		if (v) {
			const m = v.match(PAT_REGEX);
			if (m) { pat = m[1]; break; }
		}
	}
	if (!pat) {
		throw new Error(
			"mintPatViaPage: minted token modal did not surface an lm_pat_live_ string. " +
			"Check /dashboard/tokens markup; this fixture assumes the new token is rendered " +
			"in an <input readonly>, <code>, or <pre>."
		);
	}

	// The dashboard usually also surfaces the token id (uuid) — read
	// the latest row in the tokens list once we close the modal.
	await page.keyboard.press("Escape");
	let tokenId = "";
	try {
		const lastRowId = await page.locator('[data-token-id], tr[data-id]').first().getAttribute("data-token-id");
		tokenId = lastRowId || "";
	} catch { /* ignore — token_id is best-effort */ }

	return { pat, tokenId, scope, name };
}

/**
 * Mint a PAT via REST. Uses the same `lm_session` cookie the UI
 * relies on. Returns the freshly-minted PAT string. Use this when
 * the test is exercising programmatic flows and doesn't need the UI.
 *
 * `api` must already be authenticated (i.e. the loginViaApi() helper
 * has run on the same APIRequestContext).
 */
export async function mintPatViaApi(
	api: APIRequestContext,
	opts: { name?: string; scope?: string } = {},
): Promise<LumidPatToken> {
	const name = opts.name || `e2e-${Date.now().toString(36)}`;
	const scope = opts.scope || "full";

	const r = await api.post("/api/v1/tokens", {
		data: { name, scope },
		headers: { "Content-Type": "application/json" },
	});
	if (!r.ok()) {
		throw new Error(`mintPatViaApi /api/v1/tokens ${r.status()}: ${await r.text()}`);
	}
	const body = await r.json().catch(() => ({}));
	// Tolerate {data: {...}, ret_code: 0} envelope OR a bare payload.
	const payload = body.data ?? body;
	const pat = payload.token || payload.pat || payload.access_token;
	const tokenId = String(payload.id ?? payload.token_id ?? "");
	if (typeof pat !== "string" || !PAT_REGEX.test(pat)) {
		throw new Error(`mintPatViaApi: response did not include lm_pat_live_*: ${JSON.stringify(payload).slice(0, 200)}`);
	}
	return { pat, tokenId, scope, name };
}
