# 683 — P10 s4 (ask path): `muse ask --tiered` auto-routes a single question to a fast vs high-capability local model — `routeAskTierModel` classifies the query via the P10 `classifyTier` and resolves the tier models from `MUSE_FAST_MODEL` / `MUSE_HEAVY_MODEL` (each defaulting to the configured model); off by default and an explicit `--model` overrides it, so the plain ask path stays byte-identical

## Why

P10 s2+s3 (goal 682) built the deterministic `classifyTier` /
`planTieredRun` decision layer in `@muse/multi-agent`, but nothing on a
user surface consumed it — it was dormant. P10's final bullet (s4+s5)
calls for tiering "exercised end-to-end on the user surface — auto in
the `muse ask`/REPL path … AND explicit via `muse orchestrate
--tiered` — proven by a `smoke:live` round-trip …".

That bullet bundles two surfaces plus a live two-tier round-trip — too
much for one tight commit, and the live `muse ask` round-trip is
environment-blocked here (no `nomic-embed-text` pulled, so the notes
index can't be built). This iteration delivers the **`muse ask` half**:
a single ask is classified and routed to the fast or heavy model. It is
the most self-contained use of `classifyTier` (single-prompt → single
model), wired with the lowest risk.

### Scope decision

The bundled s4+s5 bullet is NOT flipped — the `muse orchestrate
--tiered` explicit surface and the `smoke:live` two-tier round-trip
remain. This commit ships the ask-path sub-capability with a green
surface-level integration check and records it in `CAPABILITIES.md`;
the bullet flips only when the orchestrate surface + live proof land.

## Slice

- `apps/cli/package.json`: add `@muse/multi-agent` workspace dependency
  (for `classifyTier` — not duplicated into the CLI).
- `apps/cli/src/commands-ask.ts`:
  - Exported `resolveAskTierModels(defaultModel, env)` — reads
    `MUSE_FAST_MODEL` / `MUSE_HEAVY_MODEL` (trimmed), each falling back
    to the configured default model.
  - Exported `routeAskTierModel(query, defaultModel, env)` — classifies
    the query and returns `{ model, tier }`.
  - `--tiered` flag (off by default). In the action: when `--tiered` is
    set AND no explicit `--model`, the dispatched model becomes the
    routed tier model and a one-line `(tier: <tier> → <model>)` note is
    written to stderr (stdout / `--json` stays clean). Absent `--tiered`
    (or with an explicit `--model`) the model selection is unchanged —
    byte-identical.
- `apps/cli/src/commands-ask.test.ts`: direct tests for
  `resolveAskTierModels` / `routeAskTierModel` (env fallback, trim,
  lookup→fast, reasoning→heavy, ambiguous→heavy).
- `apps/cli/test/program.test.ts`: a surface-level integration test that
  drives the real `muse ask --tiered` command (temp HOME + seeded notes
  index) and asserts a reasoning query surfaces
  `(tier: heavy → ollama/qwen3.6:35b-a3b)` and a lookup query surfaces
  `(tier: fast → ollama/qwen3:8b)`. The provider is pointed at an
  unreachable Ollama so the chat call fails fast AFTER the routing note.

## Verify

- `pnpm --filter @muse/cli test`: green incl. the new helper tests and
  the `muse ask --tiered` integration test (drives the real command).
- `pnpm check`: EXIT=0 — every workspace builds + tests green (the
  `apps/cli test: objectives … failed` lines are commander error-path
  test stderr, not failures).
- `pnpm lint`: 0 errors / 0 warnings.
- `pnpm check:capabilities`: ✓ every cited test/script file exists.
- Byte-hygiene scan on the three touched source/test files: clean.
- `smoke:live` not run for this slice: the change is CLI-only model
  *selection* — it does not alter any API request/response wire code
  (the existing chat `smoke:live` covers the request path; only the
  model *string* differs, and the integration test proves the routed
  model reaches the chat call). A live two-tier `muse ask` round-trip is
  also environment-blocked (no `nomic-embed-text` to build the notes
  index) and is part of the still-open s5.

## Status

P10 s4 ask-path delivered and surface-tested. Remaining for the s4+s5
bullet to flip: `muse orchestrate --tiered` explicit surface + a
`smoke:live` two-tier round-trip / low-capacity collapse.

| `muse ask` invocation                         | model used            |
| --------------------------------------------- | --------------------- |
| `--tiered` "what is X" (`MUSE_FAST_MODEL` set) | fast tier model       |
| `--tiered` "analyze X"                         | heavy tier model      |
| `--tiered` ambiguous                           | heavy (default)       |
| `--tiered --model M`                           | M (explicit override) |
| no `--tiered`                                  | default (unchanged)   |

## Decisions

- **Env-resolved tier models, not `~/.muse/models.json`** — that file
  already holds a provider-token schema (`{ version, providers }`);
  adding a `tiers` key would risk the existing reader/writer dropping
  it. `MUSE_FAST_MODEL` / `MUSE_HEAVY_MODEL` mirror the established
  `MUSE_MODEL` / `MUSE_VISION_MODEL` env convention and are zero-cost.
  A `models.json` tier block can be layered on later additively.
- **Off by default; explicit `--model` wins** — the plain ask path must
  not change behaviour; `--tiered` is opt-in and a hand-picked
  `--model` is always honoured over the classifier.
- **Add `@muse/multi-agent` as a CLI dep, don't duplicate
  `classifyTier`** — the classifier is the single source of truth in
  the tiering module; the transitive deps (agent-core / memory / model
  / shared) are already in the CLI's tree.
- **Integration test points at an unreachable Ollama** — the test
  asserts the routing *decision* at the real command surface; it must
  not depend on (or hang loading) a real local model, so the chat call
  is made to fail fast after the routing note is emitted.

## Remaining risks

- **No live two-tier `muse ask` round-trip yet** — blocked on
  `nomic-embed-text` (notes index) in this environment. The routing is
  deterministic + surface-tested; the live proof rides with s5.
- **`muse orchestrate --tiered` still single-model** — splitting
  workers across tiers in one orchestration run needs per-spec tier
  metadata on `AgentSpec` (noted in P10); that is the other half of the
  bullet and a separate slice.
- **Heuristic classifier inherits 682's bias** — an unusually phrased
  lookup routes heavy (slower, correct). Intended conservative bias.
