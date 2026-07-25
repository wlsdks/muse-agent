# Personal-agent qualification v1

`muse qualify` is Muse's read-only, fail-closed technical acceptance gate for
the current single-user runtime. It answers a narrower question than “has Muse
been useful to this person?”: whether current capability evidence, the resident
daemon identity, and the delivery posture are all safe and verifiable now.

```sh
pnpm qualify:personal-agent
# or
muse qualify --json
```

Exit status is `0` only for `qualified`. An executed technical failure produces
`not-qualified`; missing, stale, malformed, unsupported, or incomplete evidence
produces `unverified` unless another gate has already failed. Gates are never
averaged.

The JSON report uses schema v2. Its `provenance` object binds the result to the
current Git snapshot at the start and end of qualification, the current build
artifact digest/count/status, a privacy-safe runtime-identity projection, and a
deterministic SHA-256 of the technical inputs. `generatedAt` is kept separate
from that input hash so an unchanged observation has a stable identity;
`expiresAt` uses the configured evidence window capped at 24 hours. The
projection contains no raw PID, process arguments, path, environment, subprocess
error, or personal record. When the live or orphan probe is unavailable,
identity comparisons and counts are `null`; absence of observation is never
encoded as a concrete mismatch.

## Required gates

| Gate | Pass requires |
| --- | --- |
| Capability | A fresh v2 canonical 11-axis report; all required axes passed at their requested repeats; clean and unchanged source revision; source/build/eval provenance matches; current forced-build artifact digest matches. |
| Background runtime | A valid stable LaunchAgent, matching live launchd arguments and relevant environment, one matching live/list/heartbeat process identity, a fresh heartbeat newer than process birth, and no orphaned PPID-1 API dev process tree. |
| Delivery safety | The live daemon environment proves local-only, self-learning disabled, base provider `log`, the provider lock fixed to `log`, the delivery brake disengaged, and no overdue follow-up or reminder backlog. |

The report separately returns `organic-effectiveness: not-proven`. Synthetic
fixtures and technical gates cannot promote this field. Organic effectiveness
requires real user-labelled continuity outcomes.

## Program outcome scorecard

The three machine-report gates above answer a narrower question: whether the
current technical qualification is trustworthy. They are inputs to, not a
replacement for, the daily-use program scorecard. The program has eight
conjunctive outcome gates; percentages, test counts, tool calls, or a strong
component cannot average away a red or unverified row.

| Outcome gate | Green means | Admissible evidence | Never infer |
| --- | --- | --- | --- |
| Runtime | Required interactive and resident journeys finish within their bounded time, recover from expected restart/failure cases, and leave no duplicate or orphan process. | Fresh deterministic fault tests plus current controlled-live runtime evidence bound to source/build/runtime identity. | A passing unit test or installed artifact alone proves daily reliability. |
| Delivery safety | Every proposed external effect remains inside the configured local/provider boundary, uses the required draft/approval/idempotency path, and has no unresolved overdue queue. | Deterministic adversarial tests and current controlled-live provider/queue observations; organic receipts may corroborate delivery only. | A task transition or delivery receipt is feedback, permission, or future-send authority. |
| Recall | Current facts, preferences, corrections, source citations, and abstentions meet their named per-axis terminal criteria without hiding a failed axis in an aggregate. | Deterministic and controlled-live trials with frozen cases, exact denominators, freshness, and source provenance. | Synthetic scale or retrieval-component success is personal usefulness or organic effectiveness. |
| Continuity | One exact PersonalThread can produce a provenance-bound Continuity Pack, delivery, and outcome whose links remain intact across restart and storage backends. | Deterministic parity/fault tests, controlled-live end-to-end trials, and separately labelled organic outcomes. | A factual interaction receipt is an outcome label, feedback, permission, or policy promotion. |
| Privacy | Local stores, retention/deletion, secrets, provider egress, logs, exports, and backups preserve the declared owner-only and fail-closed boundaries. | Deterministic adversarial/corruption tests plus current controlled-live filesystem, provider, and recovery observations. | “Local by default,” a clean log sample, or one provider lock proves the complete privacy boundary. |
| Resource | Resident and interactive use stays within declared CPU, memory, disk, latency, token/provider-cost, retry, and queue budgets without runaway work. | Denominator-bearing controlled-live measurements and organic-production operational telemetry tied to a version and interval. | A short benchmark, idle snapshot, or synthetic throughput run proves sustainable daily cost. |
| Onboarding | The owner can complete clean setup, understand the next action, reach the first useful personal journey, and recover from a failed prerequisite without hidden manual repair. | Controlled-live clean-profile journeys and owner-labelled organic completion/friction evidence. | `OnboardReport.ready`, command success, or documentation presence alone proves adoption or value. |
| Organic value | Real owner-initiated or policy-eligible daily use produces explicitly labelled useful outcomes at the declared denominator while ignored/rejected/adjusted outcomes and friction remain visible. | Fresh `organic-production` outcomes with exact user, thread, source, time window, denominator, and explicit labels. | Deterministic, synthetic, controlled-live, factual receipt, or elapsed time can green this row. |

The scorecard is green only when every applicable technical row is green and
organic value is proven for its declared interval. Until then, the honest
program state is failed, unverified, or not-proven. Scorecard evidence never
mints `ProgressiveAutonomyOrganicAuthority` and never changes permission or
policy: autonomy promotion additionally requires the trusted organic runtime
path, exact correlation, and its own governed approval contract. Neither a
technically `qualified` report nor scorecard evidence alone is a release PASS
or release decision; release still requires every applicable, fresh roadmap
gate and its independent release evaluation.

### Decision evidence admission

Decision-grade measurements use the shared schema-v2 `DecisionMetric` contract.
`dataOrigin` (`synthetic | production | unclassified`) is immutable provenance;
`executionEvidence` (`deterministic | controlled-live | organic-production`) is
a separate execution grade. Both are required alongside a canonical source,
freshness interval, measurement window, and non-zero denominator. Missing,
unknown, stale-incoherent, or source/action/claim-incoherent records are
excluded by `admitDecisionMetric` before any qualification consumer sees them.

Only `dataOrigin=production` with
`executionEvidence=organic-production` may support the current
personal-effectiveness measurements. Synthetic or unclassified origin and
deterministic or controlled-live execution may support an explicitly technical
diagnostic only; they cannot support personal effectiveness, learning,
autonomy, permission, or release promotion.

## Capability evidence

`pnpm eval:agent -- --json` is the only producer of a pass-eligible v2 report.
The orchestrator performs a forced TypeScript project re-emit, builds the Rust
runner from a fresh locked Cargo target, atomically publishes an owner-only
fixed runner, and forces every battery to use that exact runner. Before build it
publishes an owner-only `latest-attempt.json` pointer to a UUID generation in
`attempts/`. A crash leaves that generation `running`; a terminal failure or
unverified run keeps its exact aggregate in the generation but never replaces
the canonical report. Only a complete v2 pass with clean, unchanged source and
stable artifacts is atomically promoted to `.muse-dev/evals/agent-capability/latest.json`.
The completed generation binds both files by SHA-256.

The qualifier independently re-reads the current Git revision/tree and
recomputes the canonical runtime artifact digest. It reads the attempt pointer,
state, terminal aggregate, and canonical bytes before those probes and again
afterward; a concurrent attempt or byte change is unverified. A legacy v1/v2
file without the adjacent attempt generation is unverified. A custom
`--capability-report` path uses sibling `latest-attempt.json` and `attempts/`
evidence. Evidence is valid
for at most 24 hours. `--max-evidence-age-hours` may tighten that window but
cannot raise it; `--capability-report` changes only the report input, never the
current source identity.

State authority is strict: a current command result outranks a
provenance-valid canonical report, which outranks a dated narrative snapshot.
A newer timestamp never rescues dirty, future-dated, stale, source-drifted, or
artifact-mismatched evidence.

## Runtime and delivery safety

On macOS, an on-disk plist is not proof that launchd is running the same job.
Qualification compares it with `launchctl print`, binds the list PID, print PID,
heartbeat PID, and process birth time, and reduces raw process/environment data
to closed reason codes and aggregate counts.

`MUSE_DAEMON_PROVIDER_LOCK=log` is enforced at the daemon messaging registry's
send chokepoint, including per-item provider overrides. When
`MUSE_DAEMON_DELIVERY_ENABLED=false`, the resident loop records only its
heartbeat before config, credential, model, calendar, store, registry, or tick
initialization. That brake is safe but deliberately reports `unverified`, not a
functional pass.

## Read-only and privacy contract

The command never starts, stops, installs, unloads, or signals a process; never
fires, cancels, quarantines, or rewrites personal stores; and never sends
externally. Follow-up and reminder files use strict raw readers because the
normal tolerant readers may repair or quarantine malformed state. Git reads
disable optional locks. Human and JSON reports contain no personal text,
destination, command line, cwd, raw PID, environment value, or raw subprocess
error.

Operational remediation is intentionally separate. A failed or unverified
report is a diagnosis, not permission to activate the daemon or consume a
backlog.
