# 482 — five `MUSE_USER_ID ?? USER ?? "default"` chains no longer return "" on an empty env (goal-478/481 sibling)

## Why

Continuation of the goal-481 systematic grep for
`process.env.X ?? default` patterns. Five user-scoped CLI
surfaces inlined the same defective chain:

```ts
options.user ?? process.env.MUSE_USER_ID ?? process.env.USER ?? "default"
```

- `apps/cli/src/commands-trust.ts` — `muse trust` per-user
  trusted/blocked tool list.
- `apps/cli/src/commands-approval.ts` — `muse approval`
  pending-approval audit trail.
- `apps/cli/src/commands-ask.ts` — `muse ask` user-scoped
  memory / RAG / persona.
- `apps/cli/src/chat-repl.ts` — `muse chat` per-user memory
  store key.
- `apps/cli/src/commands-proactive.ts` — `muse proactive`
  per-user fired-state tracking.

`??` only falls back on `null`/`undefined`, so a shell that
pre-clears `MUSE_USER_ID=` (a common "zero out leaked env"
launcher pattern, the same shape goals 478 / 481 fixed) leaves
the chain returning `""` at the first link — **not** falling
through to `USER` or `"default"`. The user-scoped surfaces then
operate on an empty user bucket:

- `muse trust` lists / writes trust under `""` instead of the
  caller's actual id;
- `muse approval`'s `userKey` is `""`, so the pending-approval
  trail desynchronises from the agent runtime's real user id;
- `muse ask` / `chat` looks up persona memory under `""`,
  bypassing the user's facts/prefs/vetoes — a silent
  JARVIS-context loss;
- `muse proactive` fired-state hashes under `""`, so the dedup
  window doesn't apply for the actual user.

A real, reachable, cross-cutting security/UX gap on the same
empty-env defect class as 478/481 — five near-variant inlinings,
the exact drift the 413/444 single-source convention exists to
prevent.

## Slice

- `apps/cli/src/user-id.ts` — new tiny helper
  `resolveDefaultUserKey({ override?, env? })`. Walks the
  three-link chain (`override → MUSE_USER_ID → USER`) and
  treats every link as "unset" when undefined OR empty/
  whitespace-only; trims surrounding whitespace before
  returning; default fallback `"default"`. Same shape as
  `closest-command.ts` / `ollama-url.ts` — single tiny exported
  helper, no broader surface.
- `apps/cli/src/user-id.test.ts` — 7 focused tests pinning the
  contract: every-link-unset → `"default"`; MUSE_USER_ID
  honoured; falls through to USER; **empty/whitespace-only
  treated as unset** at every link (the goal-478/481 sibling);
  explicit override beats env; empty override falls through
  (doesn't lock in `""`); trims surrounding whitespace.
- Five call-site replacements:
  `apps/cli/src/commands-trust.ts`,
  `apps/cli/src/commands-approval.ts`,
  `apps/cli/src/commands-ask.ts`,
  `apps/cli/src/chat-repl.ts`,
  `apps/cli/src/commands-proactive.ts`. Each one-line
  expression swap; the proactive site additionally drops a
  now-redundant `.trim()` since the helper trims internally.

## Verify

- Helper test 7/7 green; full `@muse/cli` suite green (780
  passed, 0 failed); tsc strict (cli) EXIT=0.
- **Clean-mutation-proven** (Edit-based): weakening the helper's
  empty-string guard (returning the candidate without
  `trim() / > 0`) makes 3 tests fail with the precise pre-fix
  symptoms (`expected '' to be 'fallback'` — empty
  MUSE_USER_ID; `expected '' to be 'env-muse'` — empty
  override; `expected '  stark  ' to be 'stark'` — whitespace
  not trimmed) while the other 4 stay green; fix restored,
  suite back to green.
- `pnpm check` EXIT=0, every workspace green — no regression;
  `pnpm lint` 0/0; `pnpm guard:core` clean (no IMMUTABLE-CORE
  touched); byte-scan clean (all 7 touched files).
- Pure CLI helper logic — no LLM / model request-response
  wire path; `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9).

## Status

Done. A user with `export MUSE_USER_ID=` (or any launcher that
pre-clears the var) no longer silently lands every user-scoped
CLI surface (`trust` / `approval` / `ask` / `chat` /
`proactive`) on an empty user bucket — the chain now falls
through to `USER` and finally `"default"` exactly as the inline
expression always intended. Five inlinings collapse to one
single-source helper; future user-scoped commands can call it
directly instead of re-deriving (the goal-413/444 anti-drift
rationale). The goal-478/481 empty-env-shadow defect class is
fully closed across the CLI user-id paths.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; a cross-cutting `fix:` discharging a
goal-478/481 sibling-asymmetry found by systematic grep,
recorded honestly with this backlog row — not a false metric.

## Decisions

- Consolidated into ONE helper + 5 call-site replacements in a
  single commit rather than five separate iterations: each
  replacement is a byte-trivial one-line expression swap of the
  identical defective chain, and the single-source helper is
  itself the anti-drift design choice (the 413/444 rationale).
  This is one coherent change of the same shape; doing five
  iterations would just multiply commit overhead.
- Helper accepts an optional `env` parameter so the
  `commands-proactive` site (which uses a bound env capture
  `e`, not `process.env`) can use the same helper. Dropped the
  redundant `.trim()` at that site since the helper trims
  internally — single source of truth.
- Placed the helper at `apps/cli/src/user-id.ts` (new tiny
  module) rather than expanding `program-helpers.ts` (already
  572 lines): matches the codebase's existing
  one-helper-per-tiny-module pattern (`closest-command.ts`,
  `ollama-url.ts`, `human-formatters.ts`).
