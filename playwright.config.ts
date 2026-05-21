import { defineConfig, devices } from "@playwright/test";
import * as dotenv from "dotenv";

// Env loads from .env.local (gitignored) first, then .env (defaults).
// Tests never read secrets directly — only through process.env via
// the fixtures layer.
dotenv.config({ path: ".env.local", override: false });
dotenv.config({ path: ".env", override: false });

// BASE_URL drives every test. Defaults to prod lum.id so `npm test`
// out-of-the-box targets the real deployment a user actually hits.
// Override to http://localhost:13080 for offline work against a
// local docker-compose stack.
const BASE_URL = process.env.BASE_URL || "https://lum.id";

// Workers normally stay at 1 because the auth specs share the OTP
// mailbox + the admin seed user. The long auto-quant spec opts into
// parallel-mode via `test.describe.configure({ mode: 'parallel' })`,
// and CI_E2E_LONG=1 lifts the global worker cap to match. Default
// (5) matches the plan; override via CI_E2E_LONG_USERS.
const LONG_MODE = process.env.CI_E2E_LONG === "1";
const WORKER_CAP = LONG_MODE
	? Number.parseInt(process.env.CI_E2E_LONG_USERS || "5", 10)
	: 1;

export default defineConfig({
	testDir: "./tests",
	fullyParallel: false, // auth tests share email mailbox + admin seed
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	workers: WORKER_CAP,
	reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"], ["html", { open: "never" }]],
	timeout: 60_000,
	expect: { timeout: 10_000 },

	use: {
		baseURL: BASE_URL,
		trace: "on-first-retry",
		screenshot: "only-on-failure",
		video: "off",
		actionTimeout: 15_000,
		navigationTimeout: 30_000,
	},

	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
		{
			name: "firefox",
			use: { ...devices["Desktop Firefox"] },
		},
	],
});
