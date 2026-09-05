# Experiment dispatch — UI test instructions

How to check, by hand, that the experiment control plane works: dispatching an
arm from the panel or the chatbox, seeing status in the app panel, and reading
results in analytics.

Written 2026-09-04. Where this file and the running system disagree, **the
system wins** — re-verify and fix this file.

Target: **https://lum.id**

---

## Before you start: which account you use changes what you see

Experiment results are **per user**. The apps and their run history belong to
`admin@lum.id`. Any other admin sees the *declarations* (the experiment, its
arms) and **no results** — `n=0`, empty variants.

That is correct scoping, not a bug. The e2e suite asserts it as a feature. If
you are checking with a different account and see no numbers, this is why.

---

## 1. Two tabs; experiments render on the workflow that owns them

**Superseded 2026-09-04/05** (two-tab redesign, plan
`review-a-previous-work-glimmering-taco.md`): there is deliberately **no
Experiments tab** any more. An earlier revision of this section asserted the
five-item nav, and a peer session read the redesign against it as a regression
and "restored" the old tabs (quant-research 0.7.37 / mbb-consultant 0.9.14,
both reverted) — this file is part of the intended-shape record, keep it
current.

| Go to | Expect |
|---|---|
| `/studio/apps/quant-research` | nav reads **Strategies · Workflows** only |
| `/studio/apps/mbb-consultant` | nav reads **Work · Workflows** only |
| `…?surface=workflows&selected=backtest` | below the run tree, a **METRIC & ARMS** section: the `backtest evidence` card (arms chip like "2 arms · 1 never run") |
| expand that card | `current` = *measured passively* (no button); `tape_covered` = **Run via chat** (it needs a subject) |
| mbb `…?surface=workflows&selected=case_eval` | `judge panel parity` card; its arms offer one-click **Run this arm** (case_eval's defaults are self-sufficient) |

> 🚩 **Red flag:** the tab only reachable by typing the URL. A route with
> nothing linking to it has shipped here before — the page existed for weeks
> and no one could find it.

---

## 2. Declared arms render — including one that has never run

Open `/studio/apps/mbb-consultant?surface=workflows&selected=interview` and find
the **METRIC & ARMS** section (there is no `/experiments` route — §1). Expand
**judge_panel_parity**.

Expect a **Declared arms** block listing both `panel_single` and
`panel_median3`, each with a run count or *"never run"*.

> 🚩 **Red flag:** an arm missing because it has no results yet. Until identity
> emitted `arms` separately from observed `variants`, a never-run arm was
> invisible — so nothing could offer to run it, which defeats the point.

---

## 3. Dispatch from the panel — and the button that must NOT exist

On the same panel, each runnable arm shows **"Run this arm"** (never run) or
**"Run 1 more"**. Click it: it becomes **queued ✓**, and a run appears in the
app's Workflows within a couple of minutes. (It may queue *behind another
tenant's live study* — the drain is single-app-concurrent, so a "queued ✓" that
hasn't produced a row yet is back-pressure, not a stall.)

Now open `…/quant-research?surface=workflows&selected=backtest` and expand
**backtest_evidence**. Its `current` arm must read **"measured passively"** with
**no button**.

That is deliberate. quant-research's `current` arm declares no configuration —
it is a *label for present behaviour*, not a runnable config. Dispatching it
fires the loop with no strategy and returns `strategy is empty`. A button that
can only fail is worse than no button; those experiments are fed by the
backtests users already run.

> 🚩 **Red flag:** a Run button on quant-research's `current`/passive arms.

---

## 3b. The KOL lane — a workflow added as spec, no UI code (2026-09-05)

The clearest test of "the surface is derived, not hand-built": `kol_strategy`
was added to quant-research as a dataset + loop + experiment declaration only.
Its row and its Metric & arms appear with zero UI change.

1. `…/quant-research?surface=workflows` → the header count includes a
   **`Kol strategy`** row (alongside Backtest / Forward test / Analyze), plus a
   **"related workflows"** section listing venue-link-matcher (a cross-app
   `config.include`).
2. `…?surface=workflows&selected=kol_strategy` → **METRIC & ARMS** with a
   **`kol alpha`** card, subtitle *"measures real tape … over musk_tweets_v1 ·
   fed by kol_strategy"*.
3. Expand it: **`current`** = *measured passively* (no button); **`musk_v1`** =
   **Run this arm** — self-sufficient: it reads the frozen tweet slice, scores a
   lean, generates a `.lqts`, submits a backtest. A resolved arm reads
   `musk_v1 · N runs · real_tape <x>`.
4. The honesty split holds here too: a `musk_v1` row that replayed recorded
   prints shows `real_tape 1.0`; one that fell back shows `0.0`. A tweet is
   never a signal — it only picks the parameterization; the backtest worker
   judges it.

> 🚩 **Red flag:** the KOL row missing while `/me/workflows` lists it (the
> surface stopped deriving), or a `real_tape=1` row whose `replay` is not
> `pg_tape` (the metric measuring the wrong axis).

---

## 4. The chatbox as a control plane

From any app page, ask the chat:

```
Run the panel_single arm of the judge_panel_parity experiment on
mbb-consultant, with case Case_002_FemaleExecutives_PK20_v5 and q Q1
```

Expect a `dispatch_experiment_arm` tool call and a reply naming the arm and the
workflow it queued.

Then ask for an arm that does not exist:

```
Run the panel_of_seven arm of judge_panel_parity on mbb-consultant
```

It must **refuse and name the real arms**. It must never quietly run the
baseline — a run recorded under a label nobody declared is indistinguishable
from a real result.

> 🚩 **Red flag:** *"I don't have a tool called dispatch_experiment_arm."* That
> means the turn stayed on a claude-code provider, whose CLI toolset cannot see
> identity's tool registry. `controlIntent` is supposed to re-route platform
> turns; if this appears, that routing regressed. It is the operator's DEFAULT
> provider, so this fails for super_admin first and everyone else last.

---

## 5. Honesty checks — the ones most worth a human eye

**The `backtest` loop description** (its Workflows row / `/me/workflows`) must
describe a backtest as a **dry run**. Any *"registers the strategy"* or *"it is
not a dry run"* is a live falsehood: the worker builds `--features pg,replay`,
so the local-replay dispatch posts no mailbox message. That text was wrong for
102 tenants until 2026-09-04; the dedicated backtests SURFACE was retired in
the two-tab redesign, so the claim now lives only in the loop description
(scripted at the contract in `30`).

**mbb-consultant `…?surface=workflows&selected=interview`** → `judge_panel_parity`
— per-arm means must appear with **no winner** and **no ✓ criteria-met badge**
while either of these holds:

- below `min_samples` (20), or
- `not comparable — N distinct instruments`.

The second means the arms were measured differently (e.g. under two different
analysts), so ranking them would measure the instrument rather than the arm.
Withholding the verdict there is the system being right.

**`/studio/library/experiments`** — cross-app list; renders without error.

---

## 6. Analytics

`/studio/admin/apps/<app>/insights` — **admin only**; a non-admin is bounced by
the route guard and the API returns 403. Reach it from the app page's **⋯ menu
→ Insights** (moved there from the top strip 2026-09-05 — a per-app admin
drill-down, not a primary action; typing the URL still works).

Look for the **"Experiment arms across the fleet"** panel: **runs *and*
failures** per arm, footnoted *"run counts across all tenants"*. Failures are
reported on purpose — an arm rollup that only showed successes would be the
kind of number this whole system exists to avoid.

Swap the app in the URL (`quant-research`, `mbb-ai`) — the page is generic over
apps; a new app costs a route param, not a handler.

**Two stores, two jobs, and they answer different questions:**

| Surface | Source | Says |
|---|---|---|
| App panel Experiments tab | the app's per-user ledger | measured results + the verdict, with the instrument guard applied |
| Admin insights rollup | `me_app_runs` (MySQL) | how many runs per arm, across all tenants — a COUNTER, never a verdict |

The ledger lives on the scheduler's volume, which identity cannot read, so the
cycle self-reports its evaluated state through the identity bridge. If the
panel shows declared arms but `n=0` for the owning account, that reporting path
is the thing to check.

---

## Automated equivalent

```bash
cd /proj/lumid_e2e

# 37 assertions, ~30s, no model spend — safe anywhere
npx playwright test tests/28-experiment-dispatch.spec.ts \
                    tests/30-experiment-hardening.spec.ts \
                    tests/31-experiment-stress.spec.ts \
                    tests/32-kol-lane.spec.ts --project=chromium

# dispatches REAL runs and spends model budget — run deliberately
npx playwright test tests/29-chatbox-control-plane.spec.ts --project=chromium
```

| Spec | Covers |
|---|---|
| `28-experiment-dispatch` | UI structure (no-tab, Metric&arms in place, KOL lane, ⋯-menu Insights), per-user isolation, rendered admin rollup |
| `29-chatbox-control-plane` | chat read, dispatch, refusal-by-name, provider routing |
| `30-experiment-hardening` | enqueue contract, access control, honesty invariants, surfaces |
| `31-experiment-stress` | concurrency, idempotency, traversal, malformed payloads |
| `32-kol-lane` | the KOL lane: three-legged declaration, derived render, and that musk_v1 has measured on REAL tape at least once |

**Do not put `29` in CI as-is.** It mutates production state and spends model
budget; it wants a tag and probably a dedicated tenant.

### How much of THIS runbook is scripted — read before trusting "it's all green"

Green specs are not a green runbook. The map, honestly:

| Runbook § | Scripted? | Where / why not |
|---|---|---|
| §1 two tabs, no Experiments tab | ✅ browser | 28 "the app panel has NO Experiments tab" |
| §2 arms render (declared + never-run) | ✅ browser + API | 28 "a loop with metric+dataset shows Metric & arms", "declared arms exposed" |
| §3 passive arm / no dead button | ✅ browser | 28 "a passive arm explains itself" (asserts absence of the button) |
| §3 **actual click → run → ledger row** | ⚠️ **manual only** | 28 stops at the button's presence/absence; the live click mutates + drains async + spends budget. The dispatch *contract* is scripted in 30/31 at the API |
| §3b KOL lane appears + Metric&arms | ✅ browser | 32 "renders as a derived surface" |
| §3b KOL musk_v1 measured on real tape | ✅ API | 32 "at least one landed on REAL tape" (asserts mean*n >= 1 real-tape hit from the aggregate — no pod access, no fresh spend) |
| §3b a FRESH live click → new verdict row | ⚠️ **manual only** | mutates + drains async behind the shared queue + spends budget; verified by hand this session (`real_tape 1.0`, pg_tape, 12,378 prints) |
| §4 chatbox dispatch | ⚠️ **spec 29, NOT in the default run** | mutates prod + spends budget; run deliberately |
| §5 honesty invariants | ✅ API | 30 "synthetic never in a real column", 28 "no unearned verdict", "verdict withheld below min_samples" |
| §6 rollup **API** | ✅ | 28 "admin insights carries a cross-tenant arm rollup" |
| §6 rollup **rendered panel** | ✅ browser | 28 "the arm rollup actually RENDERS" (added 2026-09-05 — the API-only test stayed green through a 14-version gap where nothing rendered it) |
| §6 ⋯-menu Insights reachable | ✅ browser | 28 "Insights is reachable from the app's ⋯ menu" |

So: **structure, isolation, honesty guards, the API contracts, and the rendered
surfaces are e2e-scripted in the default `28+30+31` run.** What is *not*, and
needs a human (or the tagged `29`): a live click-to-verdict, the KOL real-tape
resolution, and the chat control plane — each because it mutates production and
spends model budget, which is the wrong thing to put on every CI run.

---

## Known state (will drift — check, don't trust)

- **mbb-consultant** `judge_panel_parity`: ~14 rows, `comparable: false` —
  *"2 distinct instruments across 2 arms on analyst"*. Testing ran the arms
  under two different analysts. A clean comparison needs both arms re-run with
  the analyst pinned, behind a fresh `dataset_version`.
- **quant-research** `backtest_evidence`: now accumulating (`real_tape` reads a
  real fraction after the dataset reached the prints∩signals intersection,
  `tape_covered_v1` 1.3.0); `backtest_performance`: still `n=0` — waiting on a
  strategy real on all three axes over that intersection. `kol_alpha`:
  `musk_v1` mean ~0.5 over 2 resolved rows (one all-axes-real).

Deployed, re-verified **2026-09-05**: scheduler `v0.4.46` (fine-grained
versioning + gates) · identity **`v0.5.337`** · ui **`v0.5.330`** ·
quant-research `v0.7.4x` (kol_strategy lane live) · mbb-consultant `v0.9.20`
· venue-link-matcher `v0.3.x` (arms wired). Exact tags drift — read
`kubectl -n lumid get deploy/rollout` and the app `.xpcloud.yaml`, don't trust
this line.

---

## Changed underneath this file since it was written

None of it alters the six checks above, but it explains numbers that will look
different from the "Known state" section:

- **A scheduler misconfiguration was hiding two thirds of the fleet.**
  `LUMID_SCHEDULER_SHARD_COUNT` stayed at 3 when replicas went to 1, so the one
  pod owned `sha256(sub) % 3 == 0` — 46 of 126 tenants. Fixed; 80 tenants now
  schedule that never did.
- **Tenant cycles had no credential of their own.** They now get a per-tenant
  PAT (identity `v0.5.323`) instead of failing, or — on the Job runner —
  silently borrowing the operator's. 120 loops that had been suspended for
  repeated failure were resumed.

Full record: `/proj/QUANT-RESEARCH-WALKTHROUGH-TRIAGE.md`.

---

## Still open

1. mbb-ai's `judge_panel_arms` carries the criteria flaw fixed here
   (`delta_pp < 2` is best-vs-baseline, so it reads 0 whenever the baseline
   wins — a false pass for a parity test). Untouched: dev-box-only, n=0.
2. The scheduler pod has **no Claude CLI credential**; the gateway route works.
   An app pinned to the `claude` CLI still cannot run there.
3. ~~`scheduler-env` carries prod2-shaped values~~ — **CLOSED 2026-09-04, and
   the concern was backwards.** Home's copy is correctly adapted: 12 keys to
   prod2's 6, and `LUMID_LLM_GATEWAY_URL` already holds the public route
   (`https://lum.id/llm`), not a prod2 Service DNS name. The real hazard is the
   opposite one — `k8s-lift/lumid-scheduler-onprem/README.md` told you to copy
   prod2's secret *wholesale*, which would have overwritten that value with an
   address home k3s cannot resolve and given every cycle an unreachable
   gateway. The README now carries the key inventory (names + provenance, no
   values) and the patch step it was missing.
