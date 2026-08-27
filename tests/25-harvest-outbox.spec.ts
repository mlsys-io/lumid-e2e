import { test, expect, request as pwrequest, type APIRequestContext } from "@playwright/test";

// Journey 25 — the harvest_outbox reconciliation loop.
//
// WHY THIS EXISTS. `harvest_outbox` advances xpio.strategies from the acks in
// mailbox.lqt_outbox (via the plpgsql xpio.harvest_outbox()). It is a SCHEDULED
// loop, so nothing in the UI exercises it — and it failed on EVERY run for
// months with `RuntimeError: No LUMID_PAT env var and ~/.lumilake/pat not
// found`, reporting ok=false into a surface nobody reads. The visible symptom
// was elsewhere entirely: strategies stuck at `sent`, /xpio/stats reporting
// deployed:0, and the app's own Sessions/Backtests widgets permanently empty.
//
// Cause: LUMID_PAT is set by the intent picker from the CALLER's bearer, so it
// exists for a UI-triggered run and NOT for a cron loop. Fixed in lqt-mailbox
// v0.6.8 (xpio_client._pat() prefers the injected LQT_STRATEGY_PAT).
//
// TWO SEPARATE FAILURES, so two separate assertions. A verb that works when
// invoked says nothing about whether cron fires it, and vice versa — conflating
// them is how this stayed hidden.

const APP = "lqt-mailbox";

async function bearer(baseURL: string, email: string, password: string): Promise<string> {
  const api = await pwrequest.newContext({ baseURL });
  try {
    const r = await api.post("/api/v1/login", {
      data: { email, password }, headers: { "Content-Type": "application/json" },
    });
    if (!r.ok()) throw new Error(`login ${r.status()}`);
    return (await r.json())?.data?.token ?? "";
  } finally { await api.dispose(); }
}

async function runs(api: APIRequestContext, tok: string): Promise<any[]> {
  const r = await api.get(`/api/v1/me/apps/${APP}/data?tool=runs&loop=harvest_outbox`, {
    headers: { Authorization: `Bearer ${tok}` },
  });
  if (!r.ok()) return [];
  return (await r.json())?.data?.runs ?? [];
}

test.describe("25 — harvest_outbox reconciliation", () => {
  test.describe.configure({ mode: "serial", timeout: 420_000 });

  let tok = "";
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }, testInfo) => {
    const email = process.env.E2E_USER_EMAIL;
    const password = process.env.E2E_USER_PASSWORD;
    if (!email || !password) testInfo.skip(true, "needs E2E_USER_EMAIL + E2E_USER_PASSWORD (a role-`user`)");
    tok = await bearer(baseURL!, email!, password!);
    api = await pwrequest.newContext({ baseURL });
  });

  test.afterAll(async () => { await api?.dispose(); });

  test("the verb succeeds when invoked, and produces a NEW run", async () => {
    const before = await runs(api, tok);
    const newestBefore = before.length ? Number(before[before.length - 1].run_ts ?? 0) : 0;

    const fired = await api.post(`/api/v1/me/loops/${APP}/harvest_outbox/run`, {
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      data: {},
    });
    expect(fired.ok(), `trigger failed: ${fired.status()}`).toBeTruthy();

    // Poll for a run STRICTLY NEWER than the one we saw. Asserting only on
    // `ok` would be satisfied forever by a stale success and would never notice
    // the loop had stopped producing runs at all.
    let latest: any = null;
    await expect
      .poll(async () => {
        const r = await runs(api, tok);
        const last = r.length ? r[r.length - 1] : null;
        if (last && Number(last.run_ts ?? 0) > newestBefore) { latest = last; return true; }
        return false;
      }, { timeout: 300_000, intervals: [5_000], message: "harvest_outbox produced no new run" })
      .toBeTruthy();

    const ce = latest?.metrics?.command_engine ?? {};
    // The error text is the whole point of this spec — surface it verbatim
    // rather than letting `ok=false` fail with no cause.
    expect(latest?.ok, `harvest failed: ${String(ce.error ?? "(no error field)").slice(0, 200)}`).toBeTruthy();

    // It authenticated AND did work. A clean exit that harvested nothing is a
    // different state from one that reconciled rows, and only the first was
    // ever broken here — but a green tick on liveness alone is what let the
    // credential failure hide.
    test.info().annotations.push({
      type: "harvest-metrics",
      description: JSON.stringify(ce).slice(0, 300),
    });
  });

  test("the loop is REGISTERED with the scheduler, not just runnable", async () => {
    // Distinct failure from the above: the verb can work perfectly while cron
    // never fires it. identity exposes the scheduler's view; a loop that is
    // errored or unregistered silently stops reconciling and nothing else in
    // this suite would notice.
    const r = await api.get("/api/v1/me/loops", { headers: { Authorization: `Bearer ${tok}` } });
    expect(r.ok(), `/me/loops ${r.status()}`).toBeTruthy();
    const body = await r.json();
    const all: any[] = body?.data?.loops ?? body?.loops ?? [];
    const h = all.filter((l) => (l?.loop ?? l?.name) === "harvest_outbox");

    expect(h.length, "harvest_outbox is not known to the scheduler at all").toBeGreaterThan(0);
    const bad = h.filter((l) => l?.errored === true || l?.registered === false);
    expect(
      bad.length,
      `harvest_outbox is present but not schedulable: ${JSON.stringify(bad[0] ?? {}).slice(0, 200)}`,
    ).toBe(0);
  });
});
