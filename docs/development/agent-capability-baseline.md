# Agent capability baseline — 2026-07-19

This is the current measured baseline for Muse's live agent system. It is a
snapshot, not a claim that every agent capability is complete. The canonical
11-axis aggregate finished with **10/11 axes passed, 1 failed, and 0
unverified**. Because the recall axis executed and failed, the aggregate gate
is failed; `10/11` must not be reported as an overall pass.

The run used the local live-agent path and strict repeats for stochastic axes.
Durations below are child-process wall times from this run. They are retained
individually because adding timings or case counts from different batteries
does not create a meaningful quality score.

## Eleven-axis live aggregate

| Axis | Result | Reliability evidence | Duration |
| --- | --- | --- | ---: |
| Tool selection and arguments | passed | `pass^3` | 3,842,891 ms |
| Plan quality | passed | `pass^3` | 214,516 ms |
| Tool-argument grounding | passed | `pass^3` | 82,264 ms |
| Computer-task terminal edit | passed | `pass^3` | 164,006 ms |
| Adversarial containment and no-op | passed | `pass^3` | 686,757 ms |
| Cosine recall and abstention | **failed** | 1/1 requested run executed; see the capability gap below | 67,161 ms |
| Multi-hop retrieval lift | passed | 1/1 requested run executed | 12,753 ms |
| Orchestration failure bounds | passed | `pass^3` | 6,841 ms |
| Channel conversation rhythm | passed | `pass^3` | 79,267 ms |
| Edit-run-verify | passed | `pass^3` | 384,649 ms |
| Browser terminal task | passed | `pass^3` | 66,930 ms |

Summary: **10 passed, 1 failed, 0 unverified, 11 total**. A skip would be
`unverified`, never `passed`; this run had no skips.

An independent review after this aggregate found that the coding runner's
model-controlled `cwd` could escape its disposable fixture and that the normal
Seatbelt profile protected writes but allowed external reads. The affected
runner boundary was then made strict and the impacted edit-run-verify axis was
rerun at **3/3**. The strict runner now canonicalizes a caller-only
`isolationRoot`, rejects absolute and symlink cwd escapes before invocation,
forces `HOME` and `TMPDIR` into the fixture, and denies fixture-external file
contents at the OS sandbox. Unsupported strict isolation is `unverified`; it
never falls back to an unsandboxed child.

The independent review also caught live eval assemblies writing checkpoints
and token usage into the owner's `~/.muse`. All aggregate batteries with local
runtime state now run inside a leased disposable trial environment with
explicit checkpoint, token, memory, summary, action, config, `HOME`, XDG, and
`USERPROFILE` paths; user-memory auto-extraction is disabled. A real isolated
runner trial left the owner's 1,575-file Muse tree, token ledger size/mtime,
and checkpoint count unchanged and removed its temporary directory.

## Open capability gap: recall freshness

The recall capability report scored **18/24**. Its diagnostic views were:

- ordinary positives, top-1 retrieval: **14/14**;
- absent facts, correct abstention: **8/8**;
- correction freshness: **0/2**.

These are different metrics over different projections of the recall cases.
They are intentionally **not additive**: `14/14 + 8/8 + 0/2` must not be used
to reconstruct or replace the `18/24` capability score. The actionable gap is
correction freshness: both freshness cases failed even though ordinary top-1
retrieval and absent-fact abstention held their hard floors.

This is a **capability gap**, not evidence that a deterministic code contract
regressed. It remains red until the live recall capability itself improves and
passes its unchanged cases; passing unit tests cannot average it away.

## Separate regression and boundary evidence

The following results use different datasets and prove different contracts.
They are listed separately and must not be summed with the 11-axis aggregate or
with each other.

| Surface | Evidence | What it establishes |
| --- | --- | --- |
| Tool selection discovery baseline | **375/377** | The broad baseline exposed two misses; it is the before snapshot, not a green regression result. |
| Targeted tool-selection regression | **222/222** | The focused post-change cases passed, including a zero-exemplar-overlap held-out browser case. This is a targeted set, not a rerun or replacement denominator for the 377-case baseline. |
| Final aggregate tool-selection axis | `pass^3` | The live aggregate's tool-selection capability remained reliable across all three requested trials. |
| Safety | **150/150** | The safety regression corpus passed without averaging away a critical case. |
| Browser injection | **9/9** | The real-browser injection/defanging boundary passed its dedicated assertions. |
| SSE | `pass^3` | The live SSE path passed three consecutive requested trials. |
| Evidence-gated objective completion | `pass^3` | The live objective path passed three consecutive runs, including grounded `met` and fail-closed `unmet` cases. |
| Strict coding-runner isolation | Rust **49/49**, Node boundary **6/6**, affected live axis `pass^3` | Fixture Node execution succeeds while absolute cwd, symlink, sibling sentinel, and workspace README reads fail closed outside the canonical root. |

The progression `375/377 -> 222/222 -> aggregate pass^3` describes three
separate tool-selection observations: broad discovery, targeted regression,
and final live reliability. It does not mean `597/599`, nor does `222/222`
prove that the original 377-case dataset was rerun unchanged.

Deterministic harness contracts passed **121/121**, focused implementation
tests passed **476/476**, and the separate self-improving battery passed
**44/44**. These are regression and harness-integrity results, not additional
agent-capability attempts, so they are not added to the live aggregate.

## Operational use

- `pnpm eval:agent:offline` is the deterministic harness-contract gate suitable
  for normal CI.
- `pnpm eval:agent -- --json` runs the long local live aggregate. It belongs in
  a **nightly/self-hosted or explicit manual verification run**, not in the
  pre-push hook. The orchestrator itself performs a forced TypeScript re-emit,
  a fresh locked Rust-runner build, and forces every battery to the newly
  published runner before it writes a provenance-bearing v2 report.
- `pnpm qualify:personal-agent` revalidates that report against the current
  clean source and artifact digest, then combines it with read-only resident
  runtime and delivery-safety evidence. See
  [`personal-agent-qualification.md`](personal-agent-qualification.md).
- Pre-push remains a fast compile and affected deterministic-check boundary. A
  developer must not need a local model, Chrome, or a multi-hour live run to
  publish an otherwise verified branch.
- A recognized missing environment produces `unverified`; an executed failure,
  including an optional-environment axis, fails the aggregate.
- Every child has a 90-minute hard timeout. Each admitted run first publishes an
  owner-only UUID attempt generation. Failed/unverified aggregates remain in
  that generation; only a complete provenance-clean v2 pass is atomically
  promoted to `.muse-dev/evals/agent-capability/latest.json`. The qualifier
  rechecks the pointer, generation, report, and SHA-256 binding after its live
  source/artifact probes, so crash and concurrent-run states remain unverified.
- Capability suites may remain below 100% while exposing a real gap.
  Deterministic regression and safety suites remain all-pass gates.

Synthetic/debug raw artifacts for this work live under
`.muse-dev/evals/agent-capability/`. The repository ignores `.muse-dev/`; these
artifacts can contain local diagnostic detail and **must not be committed**.
Only qualified, privacy-safe counts, statuses, and timings belong in this
baseline document.
