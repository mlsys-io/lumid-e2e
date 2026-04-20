# Fresh-User E2E: Hybrid LQA + Cloud FlowMesh GPU (/lumid-driven)

Brand-new user on a fresh machine, through to a GPU-inferred trade landing in LQA, **driven via `/lumid` commands inside Claude Code** (not raw curl, except where `/lumid` has bugs we haven't fixed yet).

Time budget: ~5 min first run, ~1 min thereafter.

## Preflight

- **Invitation code** minted by an admin at `https://lum.id/dashboard/admin/invitations`
- **Ongoing crypto competition** on LQA with DOGEUSD (id `33` "LLM Auto-Research Arena" works as of 2026-04-20)
- **`flm-*` FlowMesh key** with user scope (e.g. `flm-704fa0d6-…`) — Phase 5 PAT-introspect on cloud FlowMesh isn't deployed yet, so a native key is still required
- **Claude Code** v2.1+ installed and on PATH

## Step 1 — Sign up at lum.id (browser)

`https://lum.id/auth/register?code=YOUR_INVITE_CODE` → email, password, username → **Send code** → OTP from `market@lum.id` in Gmail → Submit.

Land on `/dashboard`. External Gmail only — don't use `yao@lum.id` aliases (Gmail dedupes self-sends to All Mail).

## Step 2 — Mint a PAT (browser)

`https://lum.id/dashboard/tokens` → **New token** → name `hybrid-e2e`, scope **Full access** → **Mint**. Copy the `lm_pat_live_…` string from the modal.

## Step 3 — Install LumidOS + save FlowMesh key (terminal)

### Linux / macOS / WSL

```bash
curl -sSL https://lum.id/start | bash
# paste your PAT when prompted

echo 'flm-704fa0d6-sGvj7V5dsJxecH4ga1ClA0GfbS3EozU3' > ~/.flowmesh-key
chmod 600 ~/.flowmesh-key
```

### Windows PowerShell

```powershell
iwr https://lum.id/install.ps1 -useb | iex
# paste your PAT when prompted

'flm-704fa0d6-sGvj7V5dsJxecH4ga1ClA0GfbS3EozU3' | Set-Content -NoNewline "$env:USERPROFILE\.flowmesh-key"
```

**Fully quit and reopen Claude Code** (not just close the window) so the MCP registration takes effect.

## Step 4 — Drive the test via `/lumid` (Claude Code)

### 4a. Preflight inside Claude Code

```
/mcp
```

Expect `lumid ✔ connected` in the list. If missing → install didn't patch `~/.claude.json`; see *Troubleshooting*.

```
/lumid competitions
```

Expect 8 ongoing competitions including `id=33` with DOGEUSD in symbols.

```
/lumid workers
```

Expect at least 1 `IDLE` GPU worker (e.g. `wkr-3` with RTX 5090, Qwen2.5-1.5B-Instruct cached).

### 4b. Set up strategy + join competition

```
/lumid setup --competition 33 --name hybrid-e2e
```

Returns `strategy_id` + `api_token`, persists to `~/.lumilake/research/trading_loop_config.json`.

### 4c. Submit the hybrid workflow

Two paths — pick whichever your environment likes.

**Path A — via `/lumid submit` entirely inside Claude Code:**

Ask Claude directly (MCP will inline-fetch the template and substitute the token):

> Submit the hybrid-trade workflow. Use the template at https://lum.id/hybrid-trade.yaml and substitute the api_token from `~/.lumilake/research/trading_loop_config.json`. Then poll until DONE.

Claude will:

1. `curl` the YAML template
2. `sed` in your `api_token`
3. Call `/lumid submit` with the rendered YAML — now works because install patches `sdk/ops/platform.py` with `Authorization: Bearer $FLOWMESH_API_KEY`
4. Poll the workflow via the MCP workflow-status tool until terminal state

**Path B — one-shot shell runner (no Claude Code needed):**

```bash
curl -sSL https://lum.id/hybrid-demo.sh | bash
```

Does everything Path A does plus trade verification, prints `✓ Hybrid LQA + GPU workflow e2e: PASS` in ~20-30 s.

### 4d. Verify in Claude Code

```
/lumid account
```

Expect fresh DOGEUSD Buy trade, vol=5, attributed to your strategy.

Browser sanity: `https://lumid.market/strategies/<strategy_id>/trades` — your Buy at the top.

## What this proves

Passing Step 4 asserts, end-to-end:

- lum.id identity: signup, OTP email, PAT mint
- One-liner install + MCP wiring
- `/lumid competitions` + `/lumid setup` via MCP tools
- LQA introspect accepts the PAT for strategy create + competition join
- Cloud FlowMesh schema: `mloc/v1 InferenceTask` DAG with `schedule_hint.selected_worker` routing
- GPU execution: vLLM + Qwen2.5-1.5B on RTX 5090
- Stage-dependent api task: worker POSTs trade to `lumid.market/trading/api/custom/trading/order`
- Trade attribution to strategy in LQA
- `/lumid account` sees the trade via MCP

## Cleanup

Revoke the PAT via `https://lum.id/dashboard/tokens` → red **Revoke** button.

Full uninstall:

```bash
curl -sSL https://lum.id/uninstall.sh | bash -s -- --purge   # Linux/macOS/WSL
```

In Claude Code: `claude mcp remove lumid --scope user`.

## Variants

- **`HYBRID_DIRECT=1`** — skip FlowMesh, trade directly via LQA. Proves identity+strategy+trade path in ~5 s.
- **`HYBRID_VARIANT=cpu`** — swap GPU inference for CPU echo. Needs a schedulable CPU worker.

Both variants only via the shell runner, e.g. `HYBRID_DIRECT=1 bash -c 'curl -sSL https://lum.id/hybrid-demo.sh | bash'`.

## Troubleshooting

| Symptom | Diagnosis / fix |
|---|---|
| `/mcp` doesn't list `lumid` after restart | Installer didn't reach `claude mcp add`. Run manually: `claude mcp add lumid --scope user -e PYTHONUNBUFFERED=1 -e PYTHONPATH=$HOME/lumid -e RUNMESH_PAT=$(awk -F'"' '/^pat/{print $2}' ~/.lumilake/credentials.toml) -e QA_USER_JWT=<same as PAT> -e FLOWMESH_URL=https://kv.run:8000/flowmesh -e FLOWMESH_API_KEY=$(cat ~/.flowmesh-key) -e QUANTARENA_API=https://lumid.market/backend -e QUANTARENA_TRADING=https://lumid.market/trading -e LUMIDOS_SCHEDULER_URL=http://localhost:9100 -- $HOME/lumid/.venv/bin/python3 -m lumid_mcp.server` |
| `/lumid competitions` returns "tool not available" | Claude Code wasn't fully quit before restart. `/exit`, close terminal, reopen. |
| `/lumid setup` returns `405 Not Allowed` | Old installer set `QUANTARENA_API=https://lum.id/backend`; current correct value is `https://lumid.market/backend`. Re-run the one-liner. |
| `/lumid setup` returns `jwt verify: no kid` | Tool's admin-login fallback mints HS256 JWTs the post-migration middleware rejects. Installer now sets `QA_USER_JWT=$PAT` to short-circuit. Re-run. |
| `/lumid submit` returns `Connection refused` | MCP env missing `FLOWMESH_URL`. Re-run installer — current one sets it. |
| `/lumid submit` returns `Invalid API key format` | No `flm-*` key — save to `~/.flowmesh-key` then re-register MCP. |
| Workflow `max_attempts_exceeded` with empty logs | Dispatcher sent task to an `elastic_disabled=true` worker. Template pins `wkr-3` via `schedule_hint.selected_worker`; if wkr-3 is also disabled in your namespace, ask ops to re-enable. |
| OTP never arrives | External Gmail, check spam; avoid `yao@lum.id` aliases. |

## Post-mortem template

```
Run date:     YYYY-MM-DD HH:MM
Variant:      path-a / path-b / direct / cpu
Platform:     Linux / macOS / WSL / PowerShell
Email:        you+tag@gmail.com
Install time:               ___ s
Claude Code restart OK:     y / n
/mcp shows lumid connected: y / n
/lumid competitions count:  ___
/lumid setup strategy_id:   ___
Workflow submit → DONE:     ___ s
Inference output:           _______
Trade visible in /lumid account: y / n  (after ___ s)
Issues / deviations:
  _______________________
```
