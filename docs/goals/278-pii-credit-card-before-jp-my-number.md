# 278 — a space-grouped credit card leaked its last 4 digits (jp-my-number claimed the first 12)

## Why

`maskPii` / `findPii` (`@muse/policy`) are deterministic
privacy guards — `findPii` is the fail-close PII *input* guard,
`maskPii` rewrites PII out of content. Both apply the patterns in
`allPiiPatterns` **in array order**, and `String.replace` is
applied per-pattern over the running text.

`allPiiPatterns` was `[...kr, ...international, ...common]`, so
`jp-my-number` (`/\b\d{4}\s\d{4}\s\d{4}\b/`, in the international
group) ran **before** `credit-card`
(`/\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}/`, in the common group).
A 16-digit card written with spaces — the common human format —
contains a valid 12-digit `jp-my-number` match as its prefix:

```
"my card is 1234 5678 9012 3456 ok"
 jp-my-number masks  → "**** **** **** 3456"   ← last 4 digits LEAK
 finding recorded as → jp-my-number             ← misclassified
```

So a credit card pasted with spaces had its **last four digits
left in cleartext** and was reported under the wrong PII label.
For a privacy guard this is a silent leak — the exact failure
class the deterministic-security non-negotiable exists to prevent.

## Scope

`packages/policy/src/pii-patterns.ts`:

- Compose `allPiiPatterns` as `[...kr, ...common,
  ...international]` (common before international) so the broader
  16-digit `credit-card` is scanned and claims its full span
  **before** the narrower 12-digit `jp-my-number` it strictly
  contains. One-line WHY comment records the containment rationale.

No regex was changed — tightening `jp-my-number` with
look-around was rejected because a `(?<!\d[-\s])` guard would
introduce *new* false negatives on genuine JP My Numbers preceded
by an unrelated digit+space (a worse outcome for a privacy guard
than the original partial mask). Reordering is precedence-only:
verified no reverse-overlap regression — `credit-card` needs 16
digits in four groups so it can't claim an IBAN (leading
letters), `us-ssn` (3-2-4), or a standalone 12-digit
`jp-my-number`; `email`/`ipv4`/`ipv6`/`external-account-id`
require `@` / dotted-decimal / colon-hex shapes the international
numeric formats don't have. The exported group constants
(`krPiiPatterns`, …) are unchanged; only the composed scan order
moved.

## Verify

- `pnpm --filter @muse/policy test` — 54 pass. The structural
  composition test is updated to the corrected order
  (`kr → common → international`, with the credit-card ⊃
  jp-my-number reason in the title — a legitimate adjustment of a
  structural lock to the fixed order, not a weakened assertion).
  New regression: `"1234 5678 9012 3456"` masks fully to
  `****-****-****-****` (no `3456` remnant), finding is
  `credit-card` not `jp-my-number`; a genuine standalone
  `1234 5678 9012` still masks as `jp-my-number` (reorder fixed
  the overlap, didn't disable the pattern); `findPii` classifies
  the spaced card as `credit-card`. Existing representative-mask,
  IPv6, fullwidth/zero-width detection, and no-false-positive
  tests stay green.
- `pnpm check` — every workspace green (policy 54, apps/cli 561,
  apps/api 160, all packages). `pnpm lint` — exit 0.
- No real-LLM request/response path touched (deterministic
  security guard; the leak is a regex-overlap precedence problem a
  live Qwen run cannot reproduce on demand). The deterministic
  unit tests are the rigorous verification — same stance as the
  guard-hardening goals 268 / 269.

## Status

done — a space-grouped credit card is now fully masked and
classified as `credit-card`; `jp-my-number` can no longer claim
its first 12 digits and leak the last four. Genuine JP My Numbers
are unaffected, and no new false negatives were introduced.
