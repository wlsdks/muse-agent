# 120 — PII patterns include IPv6 alongside IPv4

## Why

`commonPiiPatterns` masked IPv4 (`192.168.1.100`) but had no
companion for IPv6, so any log / config / chat carrying
`2001:db8::1` survived the policy mask unredacted. The Muse
PII guard runs on the input + output paths (`packages/policy` ->
`@muse/agent-core`) so a prompt-injection user could quote an
IPv6-shaped value and it would land in the model context
verbatim. JARVIS-class masking should be format-symmetric.

## Scope

- `packages/policy/src/pii-patterns.ts`:
  - New `ipv6` entry under `commonPiiPatterns` (kept adjacent
    to `ipv4` so the cluster reads naturally).
  - Regex matches the canonical 8-group form `xxxx:…:xxxx`
    AND the `::`-compressed variants — leading (`::1`,
    `::ffff:1.2.3.4`), middle (`2001:db8::8a2e:370:7334`),
    and trailing (`2001:db8:1::`) elisions.
  - Mask string `[IPV6 MASKED]` mirrors the existing
    `[IBAN MASKED]` style for variable-length identifiers.

## Verify

- New `packages/policy/test/pii-patterns.test.ts` case pins:
  - Canonical 8-group form → masked.
  - `::1` loopback → masked.
  - Mid-string `::` compression → masked.
  - `::ffff:192.0.2.1` IPv4-mapped form → masked.
  - Mixed IPv4 + IPv6 finding counter has both names.
  - Plain English text with a colon (`"Q3 budget due: review …"`)
    is NOT mangled.
- `pnpm --filter @muse/policy test` — 50 tests pass.
- `pnpm check` exit 0; `pnpm lint` exit 0.
- `pnpm smoke:live` — 13/0 (PII guard sits on the request path;
  live round-trip unaffected).

## Status

done — IPv6 addresses are masked the same way IPv4 already was.
