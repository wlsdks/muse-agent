## 836 — feat: resolve a contact by email / handle, not just name

## Why

`resolveContact` — the recipient resolver behind `email_send` (and the
`find_contact` tool) — matched a query only against a contact's `name`
and `aliases`. So "email bob@acme.com" or "who is @bobby?" failed to
resolve the contact whose stored email/handle is EXACTLY that, falling
through to a clarify-or-unknown even though the address is the most
unambiguous identifier we have. A daily driver should resolve the
person you literally named by their address.

## Slice

`@muse/mcp` personal-contacts-store.ts — `matchesExact` now also
matches:
- the contact's `email` (exact, case-insensitive), and
- the contact's `handle` (case-insensitive, leading "@" stripped on
  both sides so "@bobby" and "bobby" are the same).
EXACT only — a full address/handle is unambiguous; email is NOT
substring-matched (so "zeta" doesn't spuriously match
`carol@zeta.com`). Name/alias matching (exact + partial) is unchanged.
Because `resolveContact` tries exact before partial, an exact email
resolves UNIQUELY even when the names alone would be ambiguous.

## Verify

`@muse/mcp` contacts-resolve-by-email.test.ts (5):
- a full email → resolved; an exact email → resolved UNIQUELY even with
  two same-name "Bob" contacts (no false ambiguity);
- a handle resolves with AND without the leading "@";
- an email SUBSTRING not in the name → `unknown` (email is exact-only,
  no spurious resolution);
- name resolution unchanged (partial name resolves / disambiguates).
- **Mutation-proven**: dropping the email clause fails the two email
  tests; dropping the handle clause fails the handle test. The existing
  contacts-tool.test.ts (9) still green. `@muse/mcp` 894/894, `pnpm
  lint` 0/0. (Full `pnpm check` shows only the known unrelated
  voice-playback `/tmp` flake — 0 non-voice failures.) This is the
  deterministic recipient resolver, not the LLM request/response path →
  no smoke:live.

## Decisions

- **Exact email/handle, never partial** — a full address is a precise
  identifier and should win; substring-matching an email domain would
  manufacture ambiguity ("acme" → everyone @acme), the opposite of
  helpful. Partial stays name/alias-only.
- **Strip a leading "@" on the handle** both sides so the user can type
  the handle however they remember it. CAPABILITIES line under P17/Reach
  recipient resolution (no bullet flip — strengthens the existing
  resolver; the email_send / find_contact surfaces inherit it).
