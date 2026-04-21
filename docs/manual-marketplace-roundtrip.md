# Manual E2E — xp.io Marketplace Round-Trip (Fresh Claude Code Users)

Two-user cookbook that proves the full `/lumid` ↔ `xp.io/marketplace`
round-trip works end-to-end: fresh install, publish, cross-account
subscribe + clone, cross-machine recall.

Time budget: ~15 min. Uses two isolated environments so neither sees
the other's state — that's the point.

**Prerequisites**
- Two Gmail accounts (or any two email providers) — sign-in is per-user.
- Access to `claude` CLI (Claude Code) on a host with docker available.
- A second browser profile (or incognito window) for anonymous browse.

---

## Setup — mint two PATs

### User A (browser profile 1)

1. Open `https://lum.id` → **Sign up** → verify OTP → you're at
   `https://lum.id/auth/account/dashboard`.
2. **Tokens** → **New token** → name `tc16-A`, scopes `*` → copy the
   `lm_pat_live_...` string. Keep it open — you'll paste it into the
   installer.

### User B (browser profile 2)

Repeat on a *different* browser profile / incognito session:
sign up, verify, mint PAT named `tc16-B`.

---

## Fresh install for both users (Claude Code entrance)

Run each install in its own shell / container / machine. The installer
is idempotent but PATs and knowledge graphs are per-user, so don't
overwrite a running user's `~/.lumilake/` or `~/.xp/` in place.

```bash
# on host A (or container A)
curl -sSL https://lum.id/start | bash -s -- lm_pat_live_<A>

# on host B (or container B)
curl -sSL https://lum.id/start | bash -s -- lm_pat_live_<B>
```

Expected final line: `✓ Lumid is ready`.

Post-install, each host has:
- `~/.lumilake/credentials.toml` (PAT)
- `~/.xp/kg/` (empty Git-backed knowledge graph)
- `~/.claude.json` updated with the `lumid` MCP server entry
  (via `claude mcp add --scope user`)

Verify in Claude Code by running:

```
/lumid xp
```

Should print `No agents yet` and `No loops yet` (clean slate).

---

## User A — teach, push, publish

Inside Claude Code on host A:

```
/lumid xp learn "DOGEUSD pumps predictably on Sundays based on retail flows." trend-watch
/lumid xp push-cloud trend-watch
```

Then publish standalone AND as a workflow bundle:

```
/lumid xp publish trend-watch --summary "DOGE Sunday watcher" --tags "crypto,doge,weekly"
```

Create a loop around the same agent, then publish the *combo*:

```
/lumid research new trend-watch --domain crypto --symbols DOGEUSD
/lumid research publish-workflow trend-watch --summary "DOGE Sunday hunt (loop × knowledge)" --tags "crypto,doge,research"
```

Note the returned `workflow_id` — `wf_...`.

**Expected state on xp.io:**

```bash
# Anonymous (no auth header) — run from anywhere, no session required
curl -s https://xp.io/api/v1/marketplace/agents    | jq '.agents[].agent_id'
# → "trend-watch"
curl -s https://xp.io/api/v1/marketplace/workflows | jq '.workflows[].name'
# → "trend-watch"
```

---

## Anonymous browse — the "no-signin stranger" test

Open `https://xp.io/marketplace` in a **third browser profile with no session cookie** (or curl). Three tabs should populate:

- **Workflows** — `trend-watch` with twin-orb `loop × knowledge` card.
- **Agents** — `trend-watch` standalone card.
- **Applications** — LQA competitions / FlowMesh workflows from upstream.

Click the workflow card — detail page shows bundled agents + the exact
`/lumid research clone-workflow <id> my-trend-watch` command needed to
clone. No sign-in required to read.

---

## User B — subscribe + clone from Claude Code

Get User A's `sub` (needed for standalone subscribe — not for clone):
from User A's Claude Code:

```
/lumid xp
```

Shows email + sub. Or hit `https://xp.io/api/v1/me` with A's PAT.

Inside Claude Code on host B:

### 1. Subscribe to the standalone agent (live updates)

```
/lumid xp subscribe <user-A-sub> trend-watch
/lumid xp ask "When does DOGE pump?"
```

**Pass criterion:** the answer or sources contain "Sunday" — the
memory was retrieved from User A's agent via subscription. Run this
**without** pulling-cloud on User B; the merge happens server-side.

### 2. Clone the workflow (snapshot + fresh loop)

```
/lumid research clone-workflow <wf_id> my-trend-watch
/lumid xp memories trend-watch
```

**Pass criteria:**
- `~/.lumilake/research/my-trend-watch/state.json` exists with `cycle: 0`.
- `xp_memories trend-watch` shows ≥ 1 memory (snapshot imported locally).

Now run a real cycle:

```
/lumid research run my-trend-watch --cycles 1
```

**Pass criterion:** the cycle completes and writes a new memory to the
cloned agent.

### 3. Verify independence (User A unpublishes)

Back on host A:

```
/lumid xp unpublish trend-watch
```

Back on host B:

```
/lumid xp ask "When does DOGE pump?" --agent trend-watch
```

**Pass criterion:** still returns the "Sunday" memory from User B's
*local* clone. Unpublishing on A breaks future subscription updates
but never retroactively nukes a clone — the cloned agent is now
User B's independently.

---

## Dashboard UI spot-check (User A, signed in)

Visit `https://xp.io/dashboard`:

- **Knowledge** page: `trend-watch` shows `◉ public` badge + `unpublish` action
  (or `publish` if you unpublished above). Subscriptions section appears empty
  (User A has none).
- **Auto-research** page: `trend-watch` loop shows `publish` action;
  **My workflows** tab shows the published workflow with `unpublish` action.
- **Applications** page: `Browse catalog` header card deep-links to `/marketplace`.
- Sidebar: 5th item **Marketplace** navigates to the public page.

Visit `https://xp.io/dashboard` on User B:
- **Knowledge** page: Subscriptions section lists `trend-watch` with owner's sub.
- Dropping the subscription via the UI stops future `ask` merges.

---

## Automated version

Everything above is codified in
`/proj/LumidOS/LumidOS/tests/integration/test_case_16_marketplace.py`.
Run:

```bash
CI_E2E_DOCKER=1 \
LUMID_ADMIN_EMAIL=<email> LUMID_ADMIN_PASSWORD=<pw> \
python3 /proj/LumidOS/LumidOS/tests/integration/test_case_16_marketplace.py
```

Spins two clean `ubuntu:24.04` containers, mints two short-lived PATs,
pipes `install.sh | bash` through both, and runs the full chain.
Revokes the PATs on exit.

---

## Failure modes worth hitting manually

| Try | Expected |
|-----|----------|
| Double-publish the same agent | Second PUT is a no-op; `visibility=public` idempotent |
| Subscribe to your own agent | `400: cannot subscribe to your own agent` |
| Clone a deleted workflow_id | `404: workflow not found` |
| Ask with no local agents, only a subscription | Returns A's memories via subscription path |
| Publish workflow with a non-existent local agent | Skipped silently (agent_snapshot has 0 memories); workflow still publishes |
| Log out, revisit `/marketplace` | Still fully browsable; sign-in only gated on subscribe/clone buttons |
