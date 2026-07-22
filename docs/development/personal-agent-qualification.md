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

## Required gates

| Gate | Pass requires |
| --- | --- |
| Capability | A fresh v2 canonical 11-axis report; all required axes passed at their requested repeats; clean and unchanged source revision; source/build/eval provenance matches; current forced-build artifact digest matches. |
| Background runtime | A valid stable LaunchAgent, matching live launchd arguments and relevant environment, one matching live/list/heartbeat process identity, a fresh heartbeat newer than process birth, and no orphaned PPID-1 API dev process tree. |
| Delivery safety | The live daemon environment proves local-only, self-learning disabled, base provider `log`, the provider lock fixed to `log`, the delivery brake disengaged, and no overdue follow-up or reminder backlog. |

The report separately returns `organic-effectiveness: not-proven`. Synthetic
fixtures and technical gates cannot promote this field. Organic effectiveness
requires real user-labelled continuity outcomes.

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
