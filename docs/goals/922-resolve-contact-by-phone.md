# Goal 922 — `resolveContact` matches by phone number (reverse lookup / inbound-sender ID)

## Outward change

The contact resolver now matches a phone-number query, so "who is
+1 415-555-0101?" (or an inbound caller/texter's number) resolves the
right contact — and `find_contact` answers it. Before, `matchesExact`
resolved by name, alias, email, and handle but NOT phone, so a phone
query fell through to `unknown` even though `find_contact`'s
description and keywords ("phone", "number", "call", "text") advertise
it. Matching is digit-based so format differences don't miss:
`415-555-0101`, `(415) 555-0101`, `4155550101`, and `+1 415 555 0101`
all resolve the same contact.

## Why this, now

Phone was the one primary identifier the exact-match set omitted —
email and handle were both added previously (the
`contacts-resolve-by-email` work), phone was left out, an asymmetric
gap. For a daily-driver assistant with inbound messaging wired (each
inbound message carries a sender phone/handle), "who is this number?"
is a real, recurring question. `resolveContact` is also the
outbound-safety recipient-resolution backbone, so this lets a user
target an outbound by a number they have on file, not just a name.

## How

Added a `phoneMatches(a, b)` helper (digits-only compare, ≥7 digits on
both sides so a short/digit-light query can't collide, suffix-match so
a local number resolves a country-code-prefixed one and vice versa)
and one clause in `matchesExact`: `contact.phone !== undefined &&
phoneMatches(contact.phone, q)`. No `find_contact` schema change — the
query param already accepts any identifier (as email/handle queries do
today), so a phone-shaped query simply now resolves; the model's tool
selection is unchanged.

## Verification

`packages/mcp` `contacts-resolve-by-phone.test.ts` (NEW; `pnpm
--filter @muse/mcp test`, 944 passing): four format variants
(`4155550101` / `415-555-0101` / `(415) 555-0101` / `+1 415 555 0101`)
all resolve the same contact; a local number resolves a stored
`+1`-prefixed one via suffix match; a short `"555"` query does NOT
spuriously match (≥7-digit guard) while a name query still resolves; a
phone with no matching contact stays `unknown`. The existing
`contacts-resolve-by-email` tests stay green (name/alias/email/handle
unchanged). Mutation-proven: forcing `phoneMatches` to return false
fails the phone-resolution tests; restored green. `pnpm check` green
(mcp 944, apps/api 323; the 2 apps/cli failures are the known
voice-playback `/tmp` mkdtemp flake — this change is mcp-only). `pnpm
lint` 0/0. No LLM round-trip / schema change → no smoke:live (Ollama
down regardless).

## Decisions

- Suffix match (not strict equality) for the ≥7-digit case so a stored
  `(212) 555-9999` resolves a `+1 212 555 9999` query — the
  country-code prefix is the common real-world mismatch; the
  digit-length floor keeps a short query from colliding.
- Kept it an EXACT-tier match (alongside email/handle), not a partial
  one, so a phone query resolves uniquely and never widens an
  otherwise-ambiguous name pool.
