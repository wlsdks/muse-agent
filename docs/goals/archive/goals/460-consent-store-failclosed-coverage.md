# 460 — Direct fail-closed coverage for the autonomous-action consent gate

## Why

`personal-consent-store.ts` (`@muse/mcp`) is the **highest-stakes
safety gate** in Muse: per its own docstring (P5-b3 / P4), "before
a standing objective may use the user's service credential to
perform an external action, the user must have recorded consent
for that exact {objective, scope}. The gate is fail-closed and
deterministic — absence of a consent record means 'do not act',
never 'ask the model'." `hasConsent` is what stops the objectives
daemon from acting as the user without authorization.

A survey of the personal-* stores (consent / veto / followup-llm-
budget all read mature: tolerant read, corrupt-quarantine,
NaN-guards, correctly fail-closed) plus a coverage check found:
the veto store has a dedicated `personal-veto-store.test.ts`, but
there is **no `personal-consent-store.test.ts` and `grep
hasConsent` across every mcp test returns nothing**. The consent
gate's fail-closed contract was **implicit-only** — exercised
only by integration happy-paths that always use well-formed
consents. A regression that broadened scope
(`=== ` → `startsWith` / substring), or stopped filtering
malformed entries, or failed open on a corrupt store, would
silently let the daemon act beyond what the user authorized while
every existing test still passed. This is the
`.claude/rules/testing.md` "no implicit-only coverage of a safety
mechanism" rule and the 407 / 434 / 438 / 458 precedent, on the
single highest-stakes uncovered gate. A `test:` — the disciplined
fallback after the probed stores read clean (no bug manufactured).

## Slice

- `packages/mcp/src/personal-consent-store.test.ts` (new, 4
  cases, temp-file harness mirroring `personal-veto-store.test.ts`):
  - **exact-match keystone**: a `github:issues:write` grant does
    NOT satisfy `github:issues:read` / `github:*` /
    `github:issues` / `…:write:extra`, nor a different
    user/objective — "consent is never broadened implicitly";
  - **fail-closed on absence / corrupt / wrong-shape**: missing
    file → false; unparseable JSON → false **and** a
    `.corrupt-*` sidecar quarantined; `{consents:"not-array"}` →
    false;
  - **malformed entry is not a phantom grant**: a
    non-`ScopedConsent` array element is filtered by
    `isScopedConsent`; a valid sibling still grants;
  - **idempotent record**: re-recording the same id REPLACES
    (no duplicate, new note wins); a different id is an
    additional grant.
- No `src` change — the gate is already correct; this pins the
  contract so a refactor can't silently disarm it.

## Verify

- New file 4/4 green; full `@muse/mcp` suite 497 passed (33
  files, +1 file / +4 it); tsc strict (mcp) EXIT=0.
- **Mutation-proven on the keystone**: changing `hasConsent`'s
  `c.scope === query.scope` to `c.scope.startsWith(query.scope)`
  (the exact "consent silently broadened" security regression)
  makes the exact-match test fail with `expected true to be
  false`; `src` then restored byte-identical (`git diff --stat`
  empty), suite back to 497 green.
- `pnpm check` EXIT=0, every workspace green (mcp 497, cli 739,
  api …) — no regression; `pnpm lint` 0/0; `pnpm guard:core`
  clean; byte-scan clean; `git status` shows ONLY the new test
  file (zero `src` delta).
- Test-only, deterministic (temp files, no clock/network/LLM) —
  not a model request/response wire path; `smoke:live` does not
  apply (per `testing.md` / iteration-loop Step 9).

## Status

Done. The autonomous-action consent gate's fail-closed contract —
exact {user,objective,scope} match (never broadened), false on
absence/corrupt/malformed, idempotent grants — now has direct,
mutation-proven unit coverage. A refactor that broadens scope,
trusts a malformed entry, or fails open on a corrupt store now
fails a fast test instead of silently letting Muse act beyond the
user's authorization.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; test-coverage hardening of an existing
safety gate, recorded honestly as a `test(mcp):` change with this
backlog row — not a false metric (the 407/434/458 precedent).

## Decisions

- Targeted the consent store specifically: the parallel veto
  store already has a dedicated test; consent was the verified
  zero-direct-coverage gap, and it is the higher-stakes of the
  two (it authorizes acting; the veto only additionally denies).
- Mutated the scope-broadening branch for the teeth proof, not a
  cosmetic one: a coverage test claimed to protect "consent is
  never broadened implicitly" must be shown to catch exactly
  that catastrophic regression — "Verified or it does not exist."
