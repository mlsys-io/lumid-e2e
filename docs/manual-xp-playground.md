# Fresh-User E2E: XP.io Knowledge Graph + PersonalAI (4 steps)

Brand-new user, fresh machine, through to a memory learned in Claude Code, synced to the **xp.io cloud**, visible on the **xp.io dashboard**, and recalled by a **PersonalAI** that auto-provisions itself from the user's Lumid PAT.

Time budget: ~5 min first run.

## Preflight

- Invitation code from an admin (registration gate at `lum.id/auth/register`).
- Browser with incognito/private mode.
- External Gmail (the OTP recipient).

That's it — **no** GitHub setup, **no** SSH keys, **no** separate xp.io password. xp.io federates identity to lum.id.

## The four steps

### 1. Browser: sign up at lum.id

`https://lum.id/auth/register?code=YOUR_INVITE_CODE` → email, password, username → receive 6-digit OTP at Gmail from `market@lum.id` → enter → lands on `/dashboard`.

### 2. Browser: mint a PAT

`https://lum.id/dashboard/tokens` → **New token** → name `xp-playground` → scope **Full access** → copy the `lm_pat_live_…`.

### 3. Terminal: install LumidOS

```bash
# Linux / macOS / WSL
curl -sSL https://lum.id/start | bash

# Windows PowerShell
iwr https://lum.id/install.ps1 -useb | iex
```

Paste the PAT when prompted. The installer handles everything:

- Clones LumidOS to `~/lumid`, creates venv, installs deps.
- **Auto-creates your personal agent** at `~/.xp/kg/agents/personal-<you>/`, keyed by the email on your PAT so multi-device sync "just works".
- Registers the `lumid` MCP server with Claude Code (`claude mcp add --scope user`) with `XPCLOUD_URL=https://xp.io` pre-set — every `/lumid xp push-cloud` / `/lumid xp pull-cloud` / `/lumid xp ask` / `/lumid teach` / `/lumid ask_me` call goes to the right place from the start.
- Starts the local scheduler at `127.0.0.1:9100`.

**Fully quit and reopen Claude Code** so the MCP registration takes effect.

### 4. Claude Code: drive the playground via `/lumid`

```
/mcp                                     # expect: lumid ✔ connected
```

**Knowledge graph round-trip:**

```
/lumid xp learn "Sparse attention on a 2B transformer gave 20% speedup with 0.5% perplexity regression." ideas
/lumid xp ask "How can I speed up transformer training?"            # recalls the memory
# Quit Claude Code fully, reopen, re-ask — memory survives.
/lumid xp push-cloud ideas                                          # sync to xp.io
```

**PersonalAI (no setup — agent auto-provisioned from your PAT):**

```
/lumid teach "I prefer trading crypto over stocks because of the 24/7 markets."
/lumid ask_me "What do I prefer?"                                   # → "crypto"
```

**Visit the dashboard:**

Open `https://xp.io/` → **Sign in with lum.id** → authorize → redirected to `/dashboard`. You should see:

- **Overview:** 1+ knowledge agents, your personal agent, maybe a memory count.
- **Knowledge:** agent list, click `ideas` → the NeurIPS memory shows up.
- **Applications:** empty until you run `/lumid setup` for LQA or a workflow.
- **Auto-research:** empty until a local research loop runs a cycle.

## One-shot smoke (bash)

Skips the UI interaction, exercises everything via the CLI:

```bash
curl -sSL https://lum.id/xp-demo.sh | bash
```

Prints `✓ XP.io + PersonalAI e2e: PASS` in ~30 s. Does: `xp learn` → subshell recall (persistence check) → `xp push-cloud` → `xp pull-cloud` round-trip → `teach` → `ask_me`.

## What this proves

- `lumid-identity` at `lum.id` is the sole OAuth/OIDC provider — xp.io has zero of its own identity surface.
- PAT-bearer (CLI) and `xp_session` cookie (browser) both resolve to the same user `sub` via `/oauth/introspect` + JWKS.
- `~/.xp/kg/` is pre-provisioned user-owned at install, sidestepping the docker-research-loop root-owned-`.git/objects/` bug.
- `xp_learn` parses free-form English into context/action/outcome via the offline extractor — no `OPENAI_API_KEY` required.
- Memories persist across Claude Code process restarts (Git-backed local store + Thompson retrieval).
- `xp_push_cloud` / `xp_pull_cloud` use the same PAT — no GitHub, no SSH.
- `/lumid teach` + `/lumid ask_me` auto-provision a `personal-<user>` agent derived from the PAT email.
- The xp.io SPA reads agents, apps, and loops through the same authed API surface.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `/mcp` doesn't list `lumid` | Fully quit Claude Code, reopen. `claude mcp list` should show `lumid`. |
| `xp_learn` returns "XP.io not available" | `pip install -e ~/lumid/XP.io.core ~/lumid/XP.io.LumidOS` in the LumidOS venv. Installer should have done this; re-run it. |
| `xp_push_cloud` returns 401 | PAT expired or revoked. Mint a fresh one at `lum.id/dashboard/tokens`, save: `sed -i "s|^pat = .*|pat = \"lm_pat_live_...\"|" ~/.lumilake/credentials.toml`. |
| `xp_push_cloud` returns "xpcloud request failed" | xp.io unreachable. `curl https://xp.io/healthz`. If down, wait or fall back to local-only. |
| Dashboard shows "No agents synced yet" after push | Browser cache — hard-reload. Or check `curl -H "Authorization: Bearer $PAT" https://xp.io/api/v1/agents` directly. |
| `xp learn` memories silently go missing | `~/.xp/kg/` is root-owned (from an old docker research loop). `sudo chown -R $USER:$USER ~/.xp/kg` and re-run. |
| `/lumid teach` says "personal AI not found" | Installer didn't seed the agent. Run `/lumid xp new-agent personal-$(whoami) personal-knowledge "personal AI"` then retry, or re-run the installer. |
| xp.io login loops back to landing | Third-party cookies blocked for `xp.io` domain. Enable site cookies in browser settings, or use a different browser. |

## Post-mortem template

```
Run date:       YYYY-MM-DD HH:MM
Platform:       Linux / macOS / WSL / PowerShell
Email:          you+xp-test@gmail.com
Install time:   ___ s
Personal agent auto-provisioned:  y / n
Learn → ask recall: y / n  (one-liner or full-sentence?)
Restart-persistence check:  y / n
Push to xp.io HTTP status:  ___
Pull round-trip memory count: ___
Dashboard agents visible:   ___
teach → ask_me returns fact: y / n
Deviations / issues:
  _______________________
```
