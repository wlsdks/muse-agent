# Personal Agent Acceptance Plan

Status: active

Started: 2026-07-20

Owner: single-user Muse runtime

## Goal

Move Muse from a strong agent platform to a trustworthy daily personal agent.
Completion means the resident runtime is truthful, corrected facts stay fresh,
learning outcomes are observable, Continuity can close through normal chat, and
real life/work returns produce reviewed outcomes across multiple dates.

This plan does not replace the Attunement roadmap. It is the operational and
evaluation gate around it. Product semantics remain in
[`docs/strategy/attunement.md`](../strategy/attunement.md), and organic
Continuity accounting remains in
[`docs/goals/attunement-implementation-plan.md`](attunement-implementation-plan.md).

## Working rules

- One narrow slice at a time. No provider, UI, or multi-agent expansion while a
  higher-priority acceptance gate is red.
- Every slice starts with measurable acceptance criteria and ends with an
  independent evaluator. Maker is not judge.
- Deterministic fixtures, controlled live execution, and organic use are
  separate evidence classes. None is promoted into another.
- Tests stay proportional to the failure: focused checks during the edit loop;
  broader gates only at the slice boundary.
- Personal links remain user-authored and exact. No hidden life/work inference,
  automatic linking, or outcome guessing.
- A completed slice is committed and published before the next slice starts.

## Current baseline

The 2026-07-20 audit established the starting point:

- deterministic built-checkout agent contracts: 121/121;
- live capability aggregate: 10/11, with corrected-fact freshness failing;
- current default organic Continuity readiness: 0 eligible reviewed deliveries;
- installed LaunchAgent artifact present, but no live launchd service and a
  stale temporary CLI entrypoint;
- multiple unmanaged daemon process groups from old and temporary checkouts
  were also observed; they do not prove resident-service health and must be
  resolved before controlled activation;
- automatic memory extraction is fail-open but does not expose outcome reasons;
- sensitive-store and warm-prompt diagnostics still have actionable warnings.

Exact counts are snapshots. Each slice records its own current evidence rather
than copying old counts forward.

## Delivery sequence

### Slice 1 — Daemon runtime truth

Separate persistent autostart artifacts from actual process state. Reject
temporary CLI entries before install. Make `muse daemon --status` and
`muse doctor` consume the same health result.

Exit gate:

- macOS reports artifact and runtime independently, including overlapping
  orphan/stale states;
- only `valid artifact + running pid` is healthy;
- Windows registration is reported as `runtime unknown`, never as proven live;
- focused daemon/Doctor tests pass and an independent evaluator approves;
- controlled activation inventories unmanaged daemon processes first, changes
  them only with explicit owner review, and finishes with exactly one intended
  resident writer;
- a later controlled activation installs from a stable entrypoint without
  sending external notices, then proves a resident PID and heartbeat.

### Slice 2 — Automatic-memory outcome observability

Keep fail-open conversation behavior, but record a reason-coded terminal result
for every extraction attempt: `learned`, `nothing_new`, `policy_rejected`,
`model_error`, `schema_error`, `store_error`, or `timeout`.

Exit gate:

- status/Doctor expose last success, consecutive failures, and reason counts;
- injected model/schema/store/timeout failures remain non-blocking and visible;
- no ephemeral/private turn is persisted through the new observation path.

### Slice 3 — Corrected-fact recall retention

Fix candidate retention before adaptive-k/MMR so a current fact and its stale
predecessor survive long enough for freshness policy to compare them.

Exit gate:

- existing correction cases pass 2/2 without changing their expected answers;
- ordinary top-1 and absent-fact abstention do not regress;
- the full live capability aggregate reaches 11/11 with strict pass^3.

### Slice 4 — Explicit chat-level Continuity seam

Expose the existing thread, exact-link, Pack, and outcome interfaces to the main
chat runtime through a minimal auditable tool seam.

Exit gate:

- chat can select/create a life or work thread, attach an exact local task/note,
  prepare a Pack, and record an explicit outcome;
- every mutation remains user-authored or user-confirmed;
- CLI/API/web behavior stays compatible and no second Attunement store appears.

### Slice 5 — Privacy repair path

Make supported sensitive-store encryption and owner-only file modes actionable,
and make local-only versus cloud egress an explicit setup decision.

Exit gate:

- high-risk local privacy warnings are zero in the controlled profile;
- repair is idempotent and never silently changes provider/effect permissions;
- backup/restore and loose-umask regressions are covered.

### Slice 6 — Local-model warm path

Measure and repair prompt-cache posture before changing model or prompt quality.

Exit gate:

- repeated-prefix warm runs are consistently faster than cold runs;
- measurements use multiple attempts and report median/p95 rather than one run;
- quality and tool-grounding gates remain unchanged.

### Slice 7 — Organic personal-agent gate

Run the finished loop in normal use. Synthetic and same-session agent-operated
examples do not count.

Exit gate:

- 20 eligible delivery/outcome pairs across both life and work;
- evidence spans at least three distinct dates and includes negative outcomes;
- reviewed evidence explains usefulness, mistiming, false positives, and
  rejected help;
- daemon, memory, recall, privacy, and performance gates remain green at the
  final review.

## Program completion

Muse passes as a personal agent only when every slice above is green. A slice may
improve the engineering score without improving the product score; only organic
multi-date outcomes close the final product gate.
