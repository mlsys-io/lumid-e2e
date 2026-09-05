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

Open `/studio/a/mbb-consultant/experiments` and expand **judge_panel_parity**.

Expect a **Declared arms** block listing both `panel_single` and
`panel_median3`, each with a run count or *"never run"*.

> 🚩 **Red flag:** an arm missing because it has no results yet. Until identity
> emitted `arms` separately from observed `variants`, a never-run arm was
> invisible — so nothing could offer to run it, which defeats the point.

---

## 3. Dispatch from the panel — and the button that must NOT exist

On the same panel, each runnable arm shows **"Run this arm"** (never run) or
**"Run 1 more"**. Click it: it becomes **queued ✓**, and a run appears in the
app's Workflows within a couple of minutes.

Now open `/studio/a/quant-research/experiments`. Both arms must read
**"measured passively"** with **no button**.

That is deliberate. quant-research's `current` arm declares no configuration —
it is a *label for present behaviour*, not a runnable config. Dispatching it
fires the loop with no strategy and returns `strategy is empty`. A button that
can only fail is worse than no button; those experiments are fed by the
backtests users already run.

> 🚩 **Red flag:** a Run button on quant-research's arms.

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

**`/studio/a/quant-research/backtests`** — the prose must describe a backtest as
a **dry run**. Any *"registers the strategy"* or *"it is not a dry run"* is a
live falsehood: the worker builds `--features pg,replay`, so the local-replay
dispatch posts no mailbox message. That text was wrong for 102 tenants until
2026-09-04, and survived one round of fixing because it lived in four places
(loop description, nav label, `ui/backtests.yaml`, README + docstring).

**`/studio/a/mbb-consultant/experiments`** — per-arm means must appear with
**no winner** and **no ✓ criteria-met badge** while either of these holds:

- below `min_samples` (20), or
- `not comparable — N distinct instruments`.

The second means the arms were measured differently (e.g. under two different
analysts), so ranking them would measure the instrument rather than the arm.
Withholding the verdict there is the system being right.

**`/studio/library/experiments`** — cross-app list; renders without error.

---

## 6. Analytics

`/studio/dashboard/admin/apps/mbb-consultant/insights` — **admin only**; a
non-admin is bounced by the route guard and the API returns 403.

Look for the experiments rollup: **runs *and* failures** per arm. Failures are
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
                    tests/31-experiment-stress.spec.ts --project=chromium

# dispatches REAL runs and spends model budget — run deliberately
npx playwright test tests/29-chatbox-control-plane.spec.ts --project=chromium
```

| Spec | Covers |
|---|---|
| `28-experiment-dispatch` | UI structure, per-user isolation, viewing + analysis |
| `29-chatbox-control-plane` | chat read, dispatch, refusal-by-name, provider routing |
| `30-experiment-hardening` | enqueue contract, access control, honesty invariants, surfaces |
| `31-experiment-stress` | concurrency, idempotency, traversal, malformed payloads |

**Do not put `29` in CI as-is.** It mutates production state and spends model
budget; it wants a tag and probably a dedicated tenant.

---

## Known state (will drift — check, don't trust)

- **mbb-consultant** `judge_panel_parity`: ~14 rows, `comparable: false` —
  *"2 distinct instruments across 2 arms on analyst"*. Testing ran the arms
  under two different analysts. A clean comparison needs both arms re-run with
  the analyst pinned, behind a fresh `dataset_version`.
- **quant-research** `backtest_evidence` / `backtest_performance`: `n=0`. These
  are passive — rows arrive when users poll real backtests. Empty is honest.

Deployed, re-verified **2026-09-04 (second pass)**: scheduler `ad456d52`
(unchanged) · identity **`v0.5.323`** · ui **`v0.5.316`** ·
quant-research `v0.7.33` (**121** installs, up from 102 — 19 tenants restored
after a scheduler migration dropped them) · mbb-consultant `v0.9.11` (2/2).

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
