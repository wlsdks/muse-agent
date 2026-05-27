# 410 — Close the named-invisible-entity injection evasion

## Why

Safety/security core (a different axis from the recent
CLI/feeds/objectives/briefing cluster). CLAUDE.md non-negotiable:
"Security is deterministic code." `normalizeForInjectionDetection`
in `@muse/policy` is that deterministic substrate — `findInjection
Patterns`, `findPii`, and `detectSystemPromptLeakage` ALL run their
untrusted input through it, so a single normalisation hole is a
cross-cutting evasion of every input/PII/leakage guard.

`decodeHtmlEntities` decoded numeric/hex entities generally but
only a hardcoded **5** named invisible entities
(`shy zwnj zwj lrm rlm`). The code's own comment + the existing
test state the principle explicitly ("Pre-fix only numeric
entities were decoded, so the named form evaded every pattern"),
but the set omitted the two **most iconic** invisibles —
`&ZeroWidthSpace;` (U+200B) and `&NoBreak;` (U+2060) — both
standard HTML5 named entities, both already in
`zeroWidthCodePoints` (so they ARE stripped once decoded), and the
invisible-math operators (`&af; &it; &ic;`). A behavioural probe
confirmed the live hole:

```
numeric  igno&#x200b;re previous instructions   → DETECTED
named    igno&ZeroWidthSpace;re ...              → *** EVADED ***
named    igno&NoBreak;re ...                     → *** EVADED ***
```

i.e. `igno&ZeroWidthSpace;re all previous instructions` slipped
past `createInjectionInputGuard` (and the PII / prompt-leakage
guards) entirely.

## Slice

- `packages/policy/src/injection-patterns.ts` —
  `namedInvisibleEntities` extended to cover **every** HTML5 named
  entity whose code point the normaliser already strips
  (`ZeroWidthSpace`→200B, `NoBreak`→2060, `af`/`ApplyFunction`
  →2061, `it`/`InvisibleTimes`→2062, `ic`/`InvisibleComma`→2063).
  The matcher regex is now **built from the map keys** (longest-
  first, case-sensitive — HTML5 entity names are) so a future
  entity addition can't desync the alternation from the table.
- `packages/policy/test/injection-patterns.test.ts` — regression
  cases: `&ZeroWidthSpace;` / `&NoBreak;` / `&it;` splitting a
  keyword are now detected (and normalise to the clean string);
  bare `&NoBreak;` in benign prose is still no false positive.
  Also dropped a `(goal 294)` marker from the edited test title
  (rides inside this change; not a standalone sweep).

The fix is bounded by an invariant, not a wish-list: the
named-entity decoder must cover exactly the invisible code points
the normaliser strips — no more (not gold-plating), no less (the
proven hole). Principled and complete.

## Verify

- `@muse/policy` injection + pii + prompt-leakage tests run
  together: 23/23 (the shared-normaliser consumers prove the fix
  closes the evasion across all three guards with no regression).
- `pnpm check` EXIT=0, every workspace green (policy 67,
  agent-core 585, mcp 485, autoconfigure 138, api 194, cli 717,
  …); tsc strict (policy) clean; `pnpm lint` 0/0; `pnpm
  guard:core` clean; byte-scan clean.
- Post-fix behavioural probe through the **rebuilt dist** (the
  artifact agent-core's guards actually load): every named-
  invisible variant now DETECTED.
- Deterministic normaliser, no model call — no request/response
  (LLM) path, so no `smoke:live` applies.

## Status

Done. The named form of `&ZeroWidthSpace;` / `&NoBreak;` /
invisible-math entities no longer splits a keyword past the
injection / PII / system-prompt-leakage guards. The decoder is now
table-driven so the matcher cannot drift from the entity set.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]`; this is a security hardening of an existing
deterministic guard substrate, recorded honestly as a
`fix(policy):` change with this backlog row — not a false metric.

## Decisions

- Completed the defense to the exact set the normaliser strips
  rather than chasing a broad HTML5-entity decoder: the invariant
  "decode iff we strip the resulting code point" is the right,
  bounded scope — a general entity decoder would risk new false
  positives and is unnecessary surface.
- Regex derived from the map (longest-first) so the historical
  failure mode that motivated the original numeric→named fix
  (matcher and table drifting apart) cannot recur.
