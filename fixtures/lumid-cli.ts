// Docker-in-docker CLI fixture for the fresh-user e2e flow.
//
// Per-worker: spins a clean `ubuntu:24.04` container, pipes the lum.id
// /start installer through bash with the test user's PAT, and exposes a
// small handle (.run([...args])) the spec can drive. Container lifetimes
// are scoped to the test — one fresh user, one fresh container, no
// cross-contamination of ~/.xp/apps/ or ~/.lumid/credentials.toml.
//
// Modeled on /proj/LumidOS/LumidOS/tests/integration/test_case_14_install_lifecycle.py
// — same install pattern, just driven from TypeScript so the Playwright
// test can interleave UI assertions with CLI commands.
//
// Skips with test.skip() when CI_E2E_LONG is unset OR docker is
// unavailable. That keeps the existing PR CI lean (no docker-in-docker
// privilege requirement) while letting the nightly self-hosted runner
// pick this up.

import { spawnSync, spawn } from "node:child_process";

export interface LumidCliResult {
	rc: number;
	stdout: string;
	stderr: string;
}

export interface LumidCli {
	containerName: string;
	run(args: string[], opts?: { timeoutMs?: number }): Promise<LumidCliResult>;
	exec(cmd: string, opts?: { timeoutMs?: number }): Promise<LumidCliResult>;
	dispose(): Promise<void>;
}

const IMAGE = process.env.TC09_IMAGE || "ubuntu:24.04";

// dockerAvailable — cheap probe; called once per worker before deciding
// whether to skip.
export function dockerAvailable(): boolean {
	const r = spawnSync("docker", ["info"], { encoding: "utf8", timeout: 5000 });
	return r.status === 0;
}

// installAvailable — quick HEAD against the install script before
// burning a 60s container-bootstrap on a misconfigured environment.
export async function installAvailable(baseURL: string): Promise<boolean> {
	try {
		const r = await fetch(`${baseURL.replace(/\/$/, "")}/start`, { method: "HEAD" });
		return r.ok;
	} catch {
		return false;
	}
}

function docker(args: string[], timeoutMs = 180_000): LumidCliResult {
	const r = spawnSync("docker", args, {
		encoding: "utf8",
		timeout: timeoutMs,
		maxBuffer: 32 * 1024 * 1024, // installer can be chatty
	});
	return {
		rc: r.status ?? -1,
		stdout: r.stdout || "",
		stderr: r.stderr || "",
	};
}

// dockerAsync — non-blocking variant for commands that may take a while
// (cycle runs in particular). Resolves on exit, captures both streams.
function dockerAsync(args: string[], timeoutMs = 180_000): Promise<LumidCliResult> {
	return new Promise((resolve) => {
		const child = spawn("docker", args, {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => { stdout += String(d); });
		child.stderr.on("data", (d) => { stderr += String(d); });
		const t = setTimeout(() => {
			child.kill("SIGKILL");
			resolve({ rc: -1, stdout, stderr: stderr + `\n[killed after ${timeoutMs}ms]` });
		}, timeoutMs);
		child.on("close", (code) => {
			clearTimeout(t);
			resolve({ rc: code ?? -1, stdout, stderr });
		});
	});
}

/**
 * Provision a docker container, install LumidOS via the public installer,
 * and return a handle the spec can drive. The container name encodes
 * the worker tag so concurrent workers never collide.
 *
 * Optional `extraVolumes`: extra `-v` args for the `docker run`. Used
 * by trading-loop tests to bind-mount the host's claude CLI + auth
 * directory (see /proj/CLAUDE.md note about Docker containers calling
 * `claude -p` via bind-mount).
 *
 * Optional `extraEnv`: extra `-e KEY=value` flags. Used to set
 * `CLAUDE_CODE=1` so the LLM caller routes through claude rather than
 * trying an API key.
 */
export async function lumidCli(opts: {
	pat: string;
	baseURL: string;
	workerTag: string;
	extraVolumes?: string[];
	extraEnv?: Record<string, string>;
}): Promise<LumidCli> {
	const containerName = `aq-e2e-${opts.workerTag}-${Date.now().toString(36)}`;
	// Best-effort cleanup of any prior container with this name.
	docker(["rm", "-f", containerName], 10_000);

	// network=host so the in-container CLI can reach `localhost`-style
	// hosts the dev box uses. On the nightly runner this is fine; on
	// shared CI a bridge network with a host alias would be safer.
	const extraVolArgs = (opts.extraVolumes || []).flatMap((v) => ["-v", v]);
	const extraEnvArgs = Object.entries(opts.extraEnv || {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
	const start = docker(
		[
			"run", "-d", "--name", containerName, "--network=host",
			...extraVolArgs,
			...extraEnvArgs,
			IMAGE, "sleep", "infinity",
		],
		30_000,
	);
	if (start.rc !== 0) {
		throw new Error(`docker run failed (${start.rc}): ${start.stderr}`);
	}

	// Bootstrap deps the installer needs. apt's network is the slow part
	// (~30-45s on a cold day), which is why this fixture lives at
	// worker-scope, not test-scope.
	const apt = await dockerAsync(
		[
			"exec", containerName, "bash", "-c",
			"apt-get update -qq && apt-get install -y -qq curl ca-certificates git python3 python3-pip python3-venv tar gzip jq >/dev/null",
		],
		300_000,
	);
	if (apt.rc !== 0) {
		docker(["rm", "-f", containerName], 10_000);
		throw new Error(`apt-get install failed (${apt.rc}): ${apt.stderr.slice(-1000)}`);
	}

	// Run the installer. The PAT is single-quoted to survive the bash -c.
	// Mirrors the working TC14 pattern verbatim.
	const installCmd = `curl -fsSL ${opts.baseURL.replace(/\/$/, "")}/start | bash -s -- '${opts.pat}'`;
	const install = await dockerAsync(
		["exec", containerName, "bash", "-lc", installCmd],
		420_000,
	);
	if (install.rc !== 0) {
		docker(["rm", "-f", containerName], 10_000);
		throw new Error(
			`install.sh exited ${install.rc}:\n--- stdout ---\n${install.stdout.slice(-2000)}\n--- stderr ---\n${install.stderr.slice(-2000)}`,
		);
	}

	const handle: LumidCli = {
		containerName,
		async run(args, runOpts = {}) {
			// `lumid` is the user-installed CLI. The installer symlinks
			// it at ~/.local/bin/lumid; ubuntu's root .profile usually
			// doesn't add that to PATH for non-interactive shells, so we
			// prepend it manually here. We also prepend $LUMID_HOME/.venv/bin
			// so the shim's `#!/usr/bin/env python3` resolves to the venv
			// python that actually has httpx/yaml/etc. (until the
			// upstream installer ships a venv-aware shebang or a
			// self-reexec). Quote each arg to keep arbitrary characters
			// safe through bash -lc.
			const quoted = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
			return dockerAsync(
				["exec", containerName, "bash", "-lc",
					`export PATH="${"$"}HOME/lumid/.venv/bin:${"$"}HOME/.local/bin:${"$"}PATH"; lumid ${quoted}`],
				runOpts.timeoutMs ?? 180_000,
			);
		},
		async exec(cmd, runOpts = {}) {
			return dockerAsync(
				["exec", containerName, "bash", "-lc", cmd],
				runOpts.timeoutMs ?? 60_000,
			);
		},
		async dispose() {
			docker(["rm", "-f", containerName], 10_000);
		},
	};
	return handle;
}
