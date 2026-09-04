import { test, expect, type APIRequestContext } from "@playwright/test";
import { loginAsAdmin } from "../fixtures/admin-session";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The chatbox as a control plane: can a person DISPATCH an experiment arm by
// asking, and does the answer reflect what actually happened?
//
// Two failures this catches, both real:
//   * identity's chat tool catalog does not reach claude-code providers, and
//     super_admin DEFAULTS to one — so the dispatch tool was unreachable from
//     the operator's own chatbox while working for everyone else;
//   * the tool used to write ~/.lumilake/jobs.jsonl on identity's pod, which
//     nothing drains. Three real user runs sat queued for a day while the chat
//     reported them queued.
//
// Model choice is explicit: the tool catalog only reaches HTTP /v1/messages
// providers, and controlIntent re-routes platform turns off claude-code. Both
// are asserted.

const CONSULTANT = "mbb-consultant";
const CHAT = "/api/v1/me/agent/chat";

function ownerToken(): string {
	return readFileSync(join(homedir(), ".lumid", "admin.pat"), "utf8").trim();
}

let owner: APIRequestContext;
test.beforeAll(async ({ playwright, baseURL }) => {
	owner = await playwright.request.newContext({
		baseURL,
		extraHTTPHeaders: { Authorization: `Bearer ${ownerToken()}` },
		timeout: 180_000,
	});
});
test.afterAll(async () => { await owner?.dispose(); });

async function ask(content: string, model?: string) {
	const res = await owner.post(CHAT, {
		data: {
			...(model ? { model } : {}),
			messages: [{ role: "user", content }],
			context: { app: CONSULTANT, page: "app-surface" },
		},
		timeout: 175_000,
	});
	expect(res.ok(), `chat HTTP ${res.status()}`).toBeTruthy();
	const d = (await res.json()).data ?? {};
	return {
		tools: (d.tool_calls ?? []).map((t: any) => t.name),
		calls: d.tool_calls ?? [],
		reply: String(d.content ?? d.reply ?? ""),
	};
}

test.describe("@chatbox experiment control plane", () => {
	test("the chatbox can READ an experiment's state", async () => {
		const r = await ask("List the experiments on this app and their arms. Use list_experiments.");
		expect(r.tools).toContain("list_experiments");
	});

	test("the chatbox DISPATCHES a declared arm", async () => {
		const r = await ask(
			"Run the panel_single arm of the judge_panel_parity experiment on mbb-consultant, " +
			"with args case=Case_002_FemaleExecutives_PK20_v5 and q=Q1. Use dispatch_experiment_arm.",
		);
		expect(r.tools, "the dispatch tool was never called").toContain("dispatch_experiment_arm");
		const call = r.calls.find((t: any) => t.name === "dispatch_experiment_arm");
		const out = call?.result ?? {};
		expect(out.error, `dispatch refused: ${out.error}`).toBeFalsy();
		expect(out.queued).toBeTruthy();
		expect(out.arm).toBe("panel_single");
		// It must queue through the intent transport — the only channel that
		// crosses from identity to the scheduler's volume.
		expect(String(out.intent_id ?? "")).toMatch(/^[0-9a-f-]{16,}$/);
	});

	test("an invented arm is refused BY NAME, not silently run as the baseline", async () => {
		const r = await ask(
			"Run the arm called panel_of_seven on the judge_panel_parity experiment " +
			"on mbb-consultant. Use dispatch_experiment_arm.",
		);
		const call = r.calls.find((t: any) => t.name === "dispatch_experiment_arm");
		if (call) {
			const err = String(call.result?.error ?? "");
			expect(err, "an undeclared arm was accepted").toMatch(/panel_of_seven/);
			// The refusal has to name the real arms so the user can correct it.
			expect(err).toMatch(/panel_single|panel_median3/);
		} else {
			// Equally acceptable: the model declined rather than inventing a call.
			expect(r.reply.toLowerCase()).toMatch(/not declared|no arm|panel_single|panel_median3/);
		}
	});

	test("a claude-code default still reaches the tool via controlIntent", async () => {
		// super_admin defaults to claude-code-sonnet, whose CLI toolset cannot
		// see the me_agent registry. controlIntent must re-route the turn.
		const r = await ask(
			"Run the panel_single arm of judge_panel_parity on mbb-consultant.",
			"claude-sonnet-4-6",
		);
		expect(
			r.tools.includes("dispatch_experiment_arm") || r.tools.includes("list_experiments"),
			`no experiment tool reached the model; reply: ${r.reply.slice(0, 160)}`,
		).toBeTruthy();
	});
});

test.describe("@chatbox is reachable from the app surface", () => {
	test("an app page mounts a chat entry point", async ({ page }) => {
		await loginAsAdmin(page);
		await page.goto(`/studio/a/${CONSULTANT}`);
		const chat = page.getByPlaceholder(/ask|message|chat/i)
			.or(page.getByRole("button", { name: /ask|chat/i })).first();
		await expect(chat).toBeVisible({ timeout: 25_000 });
	});
});
