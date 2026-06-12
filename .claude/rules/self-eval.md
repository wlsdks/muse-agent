# Self-eval scoreboard — the loop's fitness signal

`pnpm self-eval` aggregates the deterministic gates into ONE persisted
scoreboard so the autonomous loop can measure whether the system is
improving or regressing over time, instead of only verifying each change
in isolation. This is the "self-development" feedback signal.

```bash
pnpm self-eval          # quick: lint + capabilities-drift + test-file & capability counts
pnpm self-eval -- --full   # also runs the whole test suite (slow)
pnpm self-eval:test     # node:test for the pure helpers (zero deps, no Ollama)
```

## What it records

A timestamped entry appended to `docs/self-eval-scoreboard.json` (local,
gitignored — the trend lives on disk across loop fires; it is rebuildable
and deliberately NOT committed so parallel loops don't churn/conflict on
it). Each entry holds the gate results:

- `lint` — `pnpm lint` exit (pass/fail)
- `capabilities` — `pnpm check:capabilities` drift guard (pass/fail)
- `testFiles` — count of `*.test.ts(x)` across `packages/` + `apps/` (numeric)
- `verifiedCapabilities` — `docs/goals/CAPABILITIES.md` lines citing a real
  proof (numeric). **Conditional**: emitted ONLY when that ledger exists — it
  was intentionally removed (f4c195df) so the agent discovers work itself, and a
  missing file would otherwise read as a permanent `→0` regression every run. The
  count auto-resumes if a ledger is restored.
- `tests` — full suite pass/fail (only with `--full`)

## Fail-close on regression

Exit 1 when any gate fails OR a previously-passing gate now fails OR a
tracked count drops vs. the previous entry. So "regression-first" is
mechanical: the loop runs `pnpm self-eval` at the TOP of a fire and, if it
exits non-zero, **fixing that regression is the whole iteration** — before
any new capability.

## Scope (honest bounds)

This is INFRA, not an outward capability — it is built by human direction,
never as a loop iteration (the loop is outward-only). It measures progress
under the fixed guardrails; it does NOT let the loop rewrite its own goals
or honesty machinery (`IMMUTABLE-CORE` + `guard-immutable.mjs` still
apply). Self-development here = measured capability gain inside the gates,
not unbounded self-modification.
