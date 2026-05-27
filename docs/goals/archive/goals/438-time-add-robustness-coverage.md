# 438 — Pin `time_add`'s bad-base / non-numeric-offset robustness

## Why

`time_add` is one of the agent's core time tools (`@muse/tools`
`muse-tools-time.ts`) — the model calls it for "+2h" / scheduling
math. Two of its robustness behaviours were correct but
**unpinned**:

1. an unparseable `base` → a structured `{ error }` (the
   `if (!base)` branch), and
2. a non-numeric / `NaN` / `Infinity` offset field → coerced to
   `0` by `readOptionalNumber` (`Number.isFinite ? v : 0`), so
   `new Date(base + offset)` stays valid.

The existing `time_add` test only exercised valid numeric fields
(`days:1, hours:2, minutes:30`); the error branch and the
coercion were verified only by ad-hoc probing, not a test. This
matters because **reasoning-off Qwen routinely stringifies
numeric tool args** (`hours: "2"`) or emits a bad `base`; if a
refactor dropped `readOptionalNumber`'s finite-guard (or stopped
routing offsets through it), a routine "+2h" call would compute
`new Date(base + NaN)` → Invalid Date → `.toISOString()` **throws
uncaught**, surfacing an opaque tool exception instead of a
result. Implicit-only coverage of robustness on a high-traffic
tool — exactly what `.claude/rules/testing.md` forbids (407 /
424 / 434 / 435 precedent). Non-speculative: the code is
correct; this locks it in.

## Slice

- `packages/tools/test/tools.test.ts` — regression beside the
  existing `time_add` test:
  - unparseable `base` → `{ error }` containing "ISO-8601" (not a
    thrown exception);
  - `hours:"2"` + `minutes:NaN` → `offsetMs: 0`, `iso === base`
    (no Invalid-Date throw);
  - `days: Infinity` → `offsetMs: 0`, `iso === base`;
  - partial coercion: `days:"junk", hours:1` → only the valid
    field applies (`+1h`), proving it's per-field, not
    all-or-nothing.

## Verify

- `@muse/tools` time_add regression 1/1; full `@muse/tools`
  suite green (4 files / 70, +1); the existing time/text/registry
  tests unchanged (test-only addition); tsc strict (tools) clean.
- `pnpm check` EXIT=0, every workspace green (tools 70, api 196,
  cli 737, …); `pnpm lint` 0/0; `pnpm guard:core` clean;
  byte-scan clean; `git status` shows only the test file.
- Deterministic tool execution verified with literal args — not
  a model request/response path; no `smoke:live` applies.

## Status

Done. `time_add`'s "bad base → clean error" and "garbage offset →
0, never an Invalid-Date throw" robustness — the behaviour that
keeps a stringified-arg model tool call from crashing the agent's
time math — is now directly pinned. A refactor that regresses
either now fails a fast test.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]`; test-coverage hardening of an existing tool,
recorded honestly as a `test(tools):` change with this backlog
row — not a false metric. Same discipline as goals 407 / 424 /
434 / 435.

## Decisions

- Targeted `time_add` specifically: `time_diff`'s unparseable-arg
  branch (871) and `time_now`'s invalid-tz branch (850) are
  already pinned, so `time_add` was the genuine asymmetric gap —
  not a blanket time-tool test sweep.
- Asserted the **partial-coercion** case explicitly: a refactor
  to "reject the whole call if any field is non-numeric" would
  pass the simpler cases yet be a subtle behaviour change — the
  per-field-coerce contract is the highest-value branch to lock.
