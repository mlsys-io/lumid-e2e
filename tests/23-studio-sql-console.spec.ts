import { test, expect, type Page } from "@playwright/test";
import { request as pwrequest } from "@playwright/test";
import { createUser } from "../fixtures/test-user";

// Journey 23 — Studio → Data → Query (the SQL console).
//
// Runs as a FRESHLY-MINTED role-`user`, deliberately. The console exists for a
// 20-student cohort who are all role `user`; a pass as the owner (super_admin,
// every grant) would prove nothing about them. If a role gate is wrong, this is
// the spec that catches it — the admin path would stay green either way.
//
// Covers:
//   • the Query tab exists alongside Catalog / Explorer
//   • a real SELECT returns rows and a row/latency count
//   • Ctrl+Enter runs (and plain Enter does NOT — it must insert a newline)
//   • a bad query surfaces the WAREHOUSE's own message, not "query failed"
//   • an empty result reads as an empty result, not as a failure
//   • the read-only claim printed in the UI is probed, safely

const PAGE = "/studio/data";

async function login(page: Page, baseURL: string, user: { email: string; password: string }) {
  await page.goto(`${baseURL}/auth/login`);
  await page.getByLabel(/email/i).fill(user.email);
  await page.getByLabel(/password/i).fill(user.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/(dashboard|account|app|studio)/, { timeout: 20_000 });
}

async function openQueryTab(page: Page, baseURL: string) {
  await page.goto(`${baseURL}${PAGE}`);
  await page.getByRole("button", { name: /^Query$/ }).click();
  // The console is a lazy chunk — wait for its editor, not just the tab click.
  await expect(page.locator("textarea")).toBeVisible({ timeout: 20_000 });
}

async function run(page: Page, sql: string) {
  const ta = page.locator("textarea");
  await ta.fill(sql);
  await page.getByRole("button", { name: /^Run$/ }).click();
  // Settle on either a result table or the error box; never just a timeout.
  await expect
    .poll(async () => {
      if (await page.locator("table thead th").first().isVisible().catch(() => false)) return "rows";
      if (await page.locator("pre").first().isVisible().catch(() => false)) return "error";
      if (await page.getByText(/empty result, not a failure/i).isVisible().catch(() => false)) return "empty";
      return "pending";
    }, { timeout: 45_000 })
    .not.toBe("pending");
}

test.describe("23 — Studio SQL console", () => {
  // Serial with ONE shared page and ONE login. The first draft logged in per
  // test; eight full logins inside a minute left later tests staring at a
  // loading spinner and failing at unrelated locators. That reads exactly like
  // a broken console and is not -- it is the suite's own load. Same pattern as
  // spec 22.
  test.describe.configure({ mode: "serial" });

  let user: { email: string; password: string };
  let page: Page;

  // Mint an invitation code so a freshly-created account can get past the wall.
  // lum.id is invite-only: without a code the account registers FINE and then
  // parks on "Enter your invitation code", so every later step fails at its own
  // locator and looks like a broken console. That mis-diagnosis is real — it is
  // what this spec did on its first run, and what spec 22 warns about.
  async function mintInvite(baseURL: string): Promise<string> {
    if (process.env.E2E_INVITATION_CODE) return process.env.E2E_INVITATION_CODE;
    const bearer = process.env.LUMID_PAT || process.env.RUNMESH_PAT || "";
    if (!bearer) return "";
    const api = await pwrequest.newContext({ baseURL });
    try {
      const resp = await api.post("/api/v1/admin/invitation-codes", {
        headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
        data: { note: `e2e-sqlconsole-${Date.now().toString(36)}`, count: 1, max_uses: 10, ttl_days: 1 },
      });
      if (!resp.ok()) return "";
      return (await resp.json())?.data?.codes?.[0]?.code || "";
    } finally {
      await api.dispose();
    }
  }

  test.beforeAll(async ({ baseURL }, testInfo) => {
    // Two ways to get a role-`user`, in preference order.
    //
    // 1. An EXISTING normal account via E2E_USER_EMAIL/PASSWORD. Preferred: it
    //    is already past the invitation wall and needs no admin credential.
    // 2. Mint a fresh one (OTP + invitation code) when an admin PAT is around.
    //
    // What is deliberately NOT here is the admin fallback the sibling specs
    // use. This console exists for a cohort who are all role `user`; a pass as
    // super_admin would be a false green precisely where a role gate would bite.
    const email = process.env.E2E_USER_EMAIL;
    const password = process.env.E2E_USER_PASSWORD;
    if (email && password) {
      user = { email, password };
      return;
    }
    if (!process.env.E2E_GMAIL_APP_PASSWORD && process.env.CI_E2E_LOCAL_OTP !== "1") {
      testInfo.skip(true, "set E2E_USER_EMAIL+E2E_USER_PASSWORD (a role-`user`), or CI_E2E_LOCAL_OTP=1 + an admin PAT to mint one");
    }
    const invitationCode = await mintInvite(baseURL!);
    if (!invitationCode) {
      testInfo.skip(true, "lum.id is invite-only and no code could be minted: set E2E_INVITATION_CODE or LUMID_PAT/RUNMESH_PAT, or use E2E_USER_EMAIL+E2E_USER_PASSWORD");
    }
    user = await createUser(baseURL!, { tag: `sqlconsole-${Date.now().toString(36)}`, invitationCode });
  });

  test("the account under test is role `user`, not an admin", async ({ baseURL }) => {
    // Guards the whole suite against quietly becoming an admin-only pass.
    const api = await pwrequest.newContext({ baseURL });
    try {
      const r = await api.post("/api/v1/login", {
        data: { email: user.email, password: user.password },
        headers: { "Content-Type": "application/json" },
      });
      expect(r.ok()).toBeTruthy();
      const token = (await r.json())?.data?.token || "";
      const role = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString()).role;
      expect(role).toBe("user");
    } finally {
      await api.dispose();
    }
  });

  test.beforeAll(async ({ browser, baseURL }) => {
    page = await browser.newPage();
    await login(page, baseURL!, user);
  });

  test.afterAll(async () => {
    await page?.close();
  });

  test("Query tab sits alongside Catalog and Explorer", async ({ baseURL }) => {
    await page.goto(`${baseURL}${PAGE}`);
    for (const t of ["Catalog", "Explorer", "Query"]) {
      await expect(page.getByRole("button", { name: new RegExp(`^${t}$`) })).toBeVisible({ timeout: 20_000 });
    }
  });

  test("a normal user can run a SELECT and get rows", async ({ baseURL }) => {
    await openQueryTab(page, baseURL!);
    await run(page, "SELECT 1 AS one, 'abc' AS word");
    await expect(page.locator("table thead th").filter({ hasText: /^one$/ })).toBeVisible();
    await expect(page.locator("table tbody td").filter({ hasText: /^abc$/ })).toBeVisible();
    // The row/latency line is how a user knows it actually executed.
    await expect(page.getByText(/\d+ rows?\s+·\s+\d+ ms/)).toBeVisible();
  });

  test("Ctrl+Enter runs; plain Enter inserts a newline instead", async ({ baseURL }) => {
    await openQueryTab(page, baseURL!);
    const ta = page.locator("textarea");
    await ta.fill("SELECT 1 AS a");
    await ta.press("Enter");                       // must NOT submit
    await ta.type("-- still editing");
    expect(await ta.inputValue()).toContain("\n");
    await expect(page.locator("table thead th")).toHaveCount(0);

    await ta.fill("SELECT 7 AS seven");
    await ta.press("Control+Enter");                // must submit
    await expect(page.locator("table thead th").filter({ hasText: /^seven$/ }))
      .toBeVisible({ timeout: 45_000 });
  });

  test("a bad query surfaces the warehouse's own words", async ({ baseURL }) => {
    await openQueryTab(page, baseURL!);
    await run(page, "SELECT * FROM definitely_not_a_real_table_e2e");
    const err = page.locator("pre").first();
    await expect(err).toBeVisible();
    const text = ((await err.textContent()) || "").toLowerCase();
    // What we CAN assert: the console does not swallow the failure into its own
    // generic text, and the user is told the query failed rather than shown an
    // empty table.
    expect(text.trim()).not.toBe("query failed");
    expect(text).toContain("failed");

    // What we CANNOT assert yet, and why. findata's /retrieve flattens the
    // Postgres error before this layer ever sees it -- a missing relation comes
    // back as `{"detail":"bad request: sql execution failed: db error"}`. So the
    // console faithfully passes through a message that is already useless. The
    // fix belongs in findata, not here; until then this records the gap instead
    // of pretending the diagnostic exists.
    const diagnostic = /does not exist|not found|no such|relation|syntax/.test(text);
    test.info().annotations.push({
      type: "error-passthrough",
      description: diagnostic
        ? `findata returned a usable diagnostic: ${text.slice(0, 160)}`
        : `GAP -- findata flattened the cause; user sees only: ${text.slice(0, 160)}`,
    });
  });

  test("an empty result reads as empty, not as a failure", async ({ baseURL }) => {
    await openQueryTab(page, baseURL!);
    await run(page, "SELECT 1 AS x WHERE 1 = 0");
    await expect(page.getByText(/empty result, not a failure/i)).toBeVisible();
    await expect(page.locator("pre")).toHaveCount(0); // must not render as an error
  });

  test("null renders as null rather than as a blank cell", async ({ baseURL }) => {
    await openQueryTab(page, baseURL!);
    await run(page, "SELECT NULL AS maybe, 2 AS two");
    // A blank cell reads as "no data", which is a different claim than NULL.
    await expect(page.locator("table tbody td").filter({ hasText: /^null$/ }).first()).toBeVisible();
  });

  test("the read-only claim in the UI is not just copy", async ({ baseURL }) => {
    await openQueryTab(page, baseURL!);
    // Scope to the console's own hint: the Catalog summary line above also says
    // "read-only", so an unscoped match is a strict-mode violation.
    await expect(page.getByText(/read-only\s+SELECT against the/i)).toBeVisible();
    // Write-SHAPED but harmless by construction: the target cannot exist, so
    // this damages nothing even if writes were permitted. What we read is WHICH
    // error comes back -- a permission/read-only refusal (the claim holds at the
    // engine) versus a missing-relation error (the claim is only convention,
    // enforced elsewhere or not at all). Either way the console must not 200.
    await run(page, "UPDATE __e2e_nonexistent_table_probe SET x = 1 WHERE 1 = 0");
    const err = page.locator("pre").first();
    await expect(err).toBeVisible();
    const text = ((await err.textContent()) || "").toLowerCase();
    expect(text).not.toBe("");
    // Record the distinction in the report rather than asserting a guard that
    // may live in findata rather than here.
    test.info().annotations.push({
      type: "read-only-enforcement",
      description: /read-only|permission|denied|not allowed|cannot execute/.test(text)
        ? `engine refused the write: ${text.slice(0, 160)}`
        : `NOT refused as read-only; failed for another reason: ${text.slice(0, 160)}`,
    });
  });
});
