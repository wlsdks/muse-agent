# 469 — `decideWebSearchPolicy` strict-parses MAX_USES at runtime (the goal-463 runtime sibling)

## Why

Goal 463 hardened the **diagnostic** surface: `setup-status.ts`
(`muse doctor`) now strict-parses `MUSE_WEB_SEARCH_MAX_USES`, so a
typo'd `5x` / unit-slip `30s` is reported as an *invalid* env
value rather than a silently-accepted budget. But the **runtime
policy decision** that actually governs the web-search budget —
`resolveMaxUses` inside `decideWebSearchPolicy`
(`@muse/model` `web-search-policy.ts`) — still used lenient
`Number.parseInt(envRaw, 10)`:

- `Number.parseInt("3x", 10)` → `3` → finite & `>0` → **accepted
  as 3**.
- `Number.parseInt("30s", 10)` → `30`; `Number.parseInt("1e3",
  10)` → `1` (not 1000); `Number.parseInt("5.9", 10)` → `5`.

So after 463 the two surfaces **disagreed**: `muse doctor` says
`MUSE_WEB_SEARCH_MAX_USES=3x` is invalid, while the runtime
silently grants a budget of 3 — exactly the sibling-asymmetry
"fix one, the sibling carrying the identical concrete gap
remains" class (432 / 443 / 457 / 461 / 464 / 466; and 414 / 444 /
463's own lenient-`parseInt` defect class). Concrete and
reachable: a user who runs `muse doctor`, sees the value flagged,
and assumes it is therefore ignored is wrong — the runtime took
the typo'd prefix. The diagnostic must not lie about the runtime.

`packages/model` depends only on `@muse/shared`, so it cannot
import autoconfigure's `parseInteger` (wrong-direction
dependency); the strict check is mirrored **byte-for-byte** in a
tiny local `strictPositiveInt` so the runtime decision and the
`muse doctor` snapshot now apply the identical accept/reject
contract (single-standard, the 413/444 anti-drift rationale).

## Slice

- `packages/model/src/web-search-policy.ts` — `resolveMaxUses`'s
  env branch now uses `strictPositiveInt(envRaw)` (trim →
  `/^[+-]?\d+$/` → `Number.isInteger && > 0`, the exact
  semantics of goal 463's `parseInteger`) instead of
  `Number.parseInt` + `Number.isFinite && > 0`. Control flow is
  unchanged: an invalid env value still *falls through* to
  `settings.maxUses` then `DEFAULT_MAX_USES` (never throws).
  Behaviour byte-identical for a clean integer (`"9"` → 9), for
  the already-handled `"abc"` (→ fall through), and for `"0"` /
  `"-3"` (still fall through) — only the silently-accepted-typo
  path changes.
- `packages/model/src/web-search-policy.test.ts` — a new `it`
  mirroring 463's: with `settings.maxUses = 9`, each of
  `["3x","30s","1e3","5.9","12abc","1_000","-3","0"," "]` →
  `maxUses 9` (the typo is *not* taken; settings used), and a
  clean `"7"` still → `maxUses 7` (env strict-valid still wins —
  no regression).

## Verify

- New `it` green; the pre-existing `"9"` / `"abc"` /
  precedence web-search-policy tests still green (no wrong
  premise); full `@muse/model` suite green (164 passed, 5
  pre-existing cloud-key skips, +1, 0 failed); tsc strict
  (model) EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting to
  `Number.parseInt(envRaw, 10)` + `Number.isFinite && > 0`
  makes the new test fail with the precise pre-fix symptom
  (`"3x" must not be accepted as an env budget: expected 3 to be
  9` — the silently-accepted typo'd prefix) while all 8
  pre-existing tests stay green; fix restored, suite back to 9
  green.
- `pnpm check` EXIT=0, every workspace green — no regression;
  `pnpm lint` 0/0; `pnpm guard:core` clean (no IMMUTABLE-CORE
  touched); byte-scan clean; `git status` shows only the two
  intended files.
- Pure deterministic policy decision — `decideWebSearchPolicy`
  makes no LLM/model request and does not alter the
  request/response body (same classification as goal 463);
  `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9).

## Status

Done. The web-search budget the runtime actually enforces now
applies the same strict `MUSE_WEB_SEARCH_MAX_USES` parse that
`muse doctor` reports, so a typo'd / unit-slipped env value can
no longer be flagged-as-invalid by the diagnostic yet silently
honoured (as a wrong prefix) by the runtime. The 414/444/463
strict-parse standard now covers the runtime sibling 463 left.
Behaviour is byte-identical for every clean value, so nothing
configured correctly regresses.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; a 463/414/444 sibling-asymmetry
correctness `fix:`, recorded honestly with this backlog row —
not a false metric.

## Decisions

- Mirrored 463's `parseInteger` semantics in a local
  `strictPositiveInt` rather than importing it: `@muse/model`
  must not depend on `@muse/autoconfigure` (wrong layering
  direction). The accept/reject contract is identical
  (trim, `/^[+-]?\d+$/`, `Number.isInteger && > 0`) so the two
  surfaces stay in lock-step; a divergent re-derivation is
  exactly the drift this guards against.
- Preserved fall-through (not throw / not clamp) on an invalid
  env value: the function's existing contract is "invalid →
  next precedence tier"; an env typo is invalid input, and
  falling through to `settings`/`DEFAULT_MAX_USES` is strictly
  consistent with the prior `"abc"` handling — only the
  prefix-typo path is corrected.
