# Trading & Consulting apps — UI test instructions

How to check, by hand, that the two flagship app surfaces work end to end:
**Quant Research** (trading) and **MBB Consultant** (consulting). Both use the
same homogeneous two-tab shape (Objects | Workflows), the chatbox as the control
plane, and experiments rendered in place on the loop that feeds them.

Written 2026-09-06. Where this file and the running system disagree, **the system
wins** — re-verify and fix this file. Target: **https://lum.id**.

---

## Before you start: the account changes what you see

- **admin@lum.id** owns the apps and holds the run history + xpio data → use it to
  see populated tables and cross-tenant (`all_tenants`) scope.
- A **fresh `role=user`** sees `0 / 0 / 0` and per-tenant (`self_tenant`) scope —
  use it to confirm isolation and the first-run experience. Consulting also has a
  client-side **invitation gate** (`/auth/redeem-invite`); a brand-new account is
  stopped there until a code is entered.

A result table that is empty for a fresh user is usually **correct**, not a bug.

---

## App A — Quant Research (trading)

Open `/studio/apps/quant-research`.

### A1. Shape
- [ ] Exactly **two** tabs: **Strategies** and **Workflows**. There is **no**
  separate Backtest / Forward / Runtime / Experiments tab.
- [ ] Stat tiles are viewer-scoped (a fresh user sees `0`, not 315k).
- [ ] ≤ ~2 lines of prose before the first data widget; no clipped columns.

### A2. Strategies (Objects) — depends on `/xpio/strategies`
- [ ] The table renders rows (name, `program_hash`, status, created) — **not** a
  perpetual spinner or an error toast.
- [ ] Network tab: `…/xpio/strategies` returns **200** (regression guard — this
  was 500 before the secondary-pool fix).
- [ ] Row actions offer Backtest / Forward test / Discuss.

### A3. Deploy a strategy from chat (the control plane)
- [ ] In the docked chat, ask: *"write a simple momentum strategy and deploy it."*
- [ ] The reply is a **compilable `.lqts`** (a `params { … }` block, `signal(...)`,
  `when <cond> { buy/sell … }` with an entry **and** an exit) — it does **not**
  hunt the filesystem or refuse. (Grammar-injection fix, identity v0.5.338.)
- [ ] Approve the `send_strategy` action → it waits for the compiler and reports
  `deployed` (+ `program_hash`) or `rejected` (+ the exact parse error) — never
  "queued" for a rejection.

### A4. Workflows + experiments
- [ ] **Workflows** tab lists loops one per row: `backtest`, `forward_test`,
  `analyze`, `kol_strategy`; scheduled plumbing collapses under a count.
- [ ] Open **backtest** → runs list loads, and because it has a metric + dataset
  it shows **Metric & arms** in place (no separate Experiments page).
- [ ] Expand the evidence card → arms show; a passive arm explains itself
  ("measured passively") instead of offering a dead "Run this arm" button.

### A5. A run is the only detail page
- [ ] Any run row → `/studio/runs/:id` shows outputs/artifacts, and the honesty
  axes `replay` / `signals` / `settlement`.
- [ ] `replay = pg_tape` = real history; `synthetic_lcg` = labelled fallback; a
  result with **no** `replay` field reads as not-real, never "probably fine".

### A6. KOL lane
- [ ] Open **kol_strategy** → a run reads the frozen `musk_tweets_v1`, scores a
  lean, parameterizes a strategy, and backtests it. A tweet only picks which of
  `vpin`/`ofi_z`/`outcome_forecast` to trade — the tape decides the number.

### A7. Executor feeds (regression guard for the /xpio fix)
- [ ] Ask the chat *"how many strategies are deployed?"* / *"recent xpio results"*
  → real counts, backed by `/xpio/stats` + `/xpio/results` (both **200**).

---

## App B — MBB Consultant (consulting)

Open `/studio/apps/mbb-consultant`.

### B1. Shape
- [ ] Exactly **two** tabs: **Work** and **Workflows**. No separate Results or
  Experiments tab.
- [ ] Overview is a **case browser** (50 labelled cases).

### B2. Pick a mode, then a case (Work)
- [ ] Choose the mode **first**: *AI interviews you* / *AI answers a case* /
  *Ask anything*. Pick **AI interviews you** for the first pass.
- [ ] Press **Start** → chat opens already grounded in the case (no pasting).

### B3. Work it in the chat
- [ ] Every reply ends by telling you the next move. `scorecard`, `next question`,
  and `wrong — …` all work.
- [ ] Answer the **question asked**, not the case theme. Each answer is scored
  with `app_judge` against that case's ground-truth keypoints.

### B4. Read the score
- [ ] The scored turn shows **Mode** (`casebook` = grounded number; `open` =
  indicative only — carries the no-ground-truth caveat verbatim), **Score**
  (covered ÷ available), the three rubric axes, and **Judges** (2 = healthy;
  1 = a seat was unavailable, flagged low-confidence, never a silent zero).

### B5. Workflows + experiments
- [ ] **Workflows** tab: `interview` and `case_eval`, one row each. Open one for
  its runs; `judge_panel_parity`'s **Metric & arms** renders on the loop.
- [ ] A verdict is withheld below `min_samples` **or** when the instrument guard
  fires (arms measured under different judge panels are "not comparable") — the
  reason is stated, never a silent average.

### B6. Corrections — the compounding part (Work → Review queue)
- [ ] In chat: `wrong — the issue tree should split cost before volume` → a draft
  lands in the **Review** queue (nothing applied while it sits there).
- [ ] Beside **Approve**: **Measure as arm** (test the edit over `cases_v1` via
  `case_eval` before adopting) and **Add to casebook** (stage a gap as a
  candidate case, bumping `dataset_version` on accept).
- [ ] The sidebar badge = this queue; empty = nothing waiting on you.

### B7. Isolation (as a second account)
- [ ] Results, Review and corrections are scoped to your account; you never see
  another user's turns. The casebook is mounted **read-only** from a published
  dataset (everyone scored against the same ground truth).

---

## What "normal" feels like
- Consulting scored turn (analyst answers + two judges read it): **2–3 minutes**,
  not a hang; the first turn of a session is slowest. Refreshing mid-turn costs
  you the reply.
- Trading backtest is a dry run inside `lqt-backtest-worker` — it posts no mailbox
  message, so it does **not** register or deploy the strategy.

## If a whole tab errors "app not found"
The app was installed under a bare name instead of its `owner/name` slug —
uninstall and reinstall from the Marketplace (which sends the qualified slug).

---

## Automated coverage
Scripted specs for these surfaces live in `tests/28–32-*.spec.ts`
(28 dispatch/structure, 29 chatbox, 30–31 surfaces, 32 KOL lane). The
experiment-dispatch companion checklist is `docs/EXPERIMENT-UI-TESTING.md`.
