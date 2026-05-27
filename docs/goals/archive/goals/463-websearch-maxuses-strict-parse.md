# 463 — `readWebSearchEnvSnapshot` rejects a lenient-prefix MUSE_WEB_SEARCH_MAX_USES typo (414/444 sibling)

## Why

`readWebSearchEnvSnapshot` (`@muse/autoconfigure`
`setup-status.ts`) feeds the user-facing setup-readiness surfaces
(`muse … --json` and `GET /api/setup/status` — the "is Muse
configured? what's set?" diagnostic). It parsed
`MUSE_WEB_SEARCH_MAX_USES` with raw `Number.parseInt(rawMax, 10)`.

`Number.parseInt("5x", 10) === 5`, `parseInt("30s") === 30`,
`parseInt("1_000") === 1`. So a typo / unit-slip
`MUSE_WEB_SEARCH_MAX_USES=5x` was silently reported as
`{ maxUses: 5, source: "env" }` — i.e. the diagnostic that
exists to tell the user their config state actively tells them a
typo'd value is a *valid, env-configured* setting. This is the
exact 414 / 444 lenient-`parseInt` footgun (414's docstring: "a
typo'd MUSE_* would silently mis-configure"), and the
**hardened `parseInteger` already lives in the same package**
(`./env-parsers.js`, the goal-414/444 strict parser) — this
sibling just bypassed it with raw `Number.parseInt`.

The existing test covered `"abc"` (pure NaN → default) but not
the dangerous **lenient-prefix** case (`"5x"` → 5, looks valid) —
so the actual footgun was **genuinely uncovered**. The 414 / 444
/ 457 sibling-asymmetry class, reachable (user-set env var),
non-speculative (the codebase has a documented standing decision
this is a defect class), on a diagnostic surface where a wrong
verdict directly misleads onboarding.

## Slice

- `packages/autoconfigure/src/setup-status.ts` — import the
  already-present hardened `parseInteger` and replace
  `Number.parseInt(rawMax,10)` + `Number.isFinite(n) && n > 0`
  with `parseInteger(rawMax, 0)` + `n > 0`. `parseInteger`
  rejects any non-plain-decimal token (`"5x"`, `"30s"`,
  `"1_000"`, `"-3"`, `"0"`, `" "`) → falls back to `0` → the
  `> 0` gate keeps the default and **does not** set
  `source: "env"`. Behaviour byte-identical for a clean positive
  integer (`"12"` → 12/env) and for the existing `"abc"` case
  (NaN→default, source unchanged) — no regression; only the
  silently-accepted-typo path is fixed. Single-source reuse of
  the package's own strict parser (the 413/444 anti-drift
  rationale), not a re-derived check.
- `packages/autoconfigure/test/setup-status.test.ts` — a new
  `it`: `["5x","30s","12abc","1_000","0","-3"," "]` each →
  `{ maxUses: 5 (default), source: "default" }` (NOT env); a
  clean `"8"` still → `{ maxUses: 8, source: "env" }`.

## Verify

- New `it` green; full `@muse/autoconfigure` suite 141 passed
  (8 files, +1); the pre-existing `"12"` / `"abc"` web-search
  tests still green (no wrong premise); tsc strict
  (autoconfigure) EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting to
  `Number.parseInt` + finite/`>0` makes the new test fail —
  `"5x"` yields `source: "env"` (and `"30s"` → `maxUses: 30`)
  instead of the rejected default; fix restored, suite back to
  141 green.
- `pnpm check` EXIT=0, every workspace green (autoconfigure 141,
  cli 739, api …) — no regression; `pnpm lint` 0/0;
  `pnpm guard:core` clean; byte-scan clean; `git status` shows
  only the two intended files.
- Pure deterministic env-snapshot parsing — no LLM / model
  request-response wire path; `smoke:live` does not apply (per
  `testing.md` / iteration-loop Step 9).

## Status

Done. The setup-status / `muse doctor` web-search readout no
longer reports a typo'd `MUSE_WEB_SEARCH_MAX_USES` as a valid
env-configured value — a malformed setting now correctly shows
the default with `source: "default"`, so the diagnostic tells the
truth about the user's config. Clean positive integers are
unaffected.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; a 414/444 sibling-asymmetry
robustness `fix:` to an existing diagnostic surface, recorded
honestly with this backlog row — not a false metric.

## Decisions

- Reused `parseInteger` from `./env-parsers.js` (already imported
  for `parseBoolean` in this file) rather than re-deriving a
  strict check: a second integer-parse predicate is exactly the
  drift the 413/444 single-source fixes prevent; the package's
  hardened parser is the one source of truth.
- Surveyed `openai-compat-presets` / `response-filters` /
  `provider-paths` / `setup-status` before acting; the first
  three read mature (provider-paths is a *correct* single-source
  427 fix), this raw-`parseInt` sibling is the one concrete
  reachable defect found — not manufactured.
