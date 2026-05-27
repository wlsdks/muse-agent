# 702 — P13 target-completion audit (the P→P seam check)

## Why

P0–P12 are audited; P13 (contacts — the recipient-resolution backbone
for outbound safety) is the next oldest completed target with no
`P13 audit —` line. Per the iteration-loop PROCEDURE Step 4, the sole
mandate is to re-run every P13 `CAPABILITIES.md` check TOGETHER AND
exercise P13 as one end-to-end user flow against the falsifiable test
("known contact resolves; ambiguous → clarify, never a guessed
address").

## Verify (all re-run green TOGETHER)

- `@muse/mcp` 7/7 — personal-contacts-store.test.ts: store round-trip
  (add / query / idempotent-replace / remove) + `resolveContact`
  resolved / by-alias / exact-over-substring / ambiguous / unknown /
  empty.
- `@muse/cli` 6/6 — commands-contacts.test.ts (add/list/resolve;
  ambiguous → candidates + exit 1; not-found exit 1) + the consumption
  seam p11-email-contacts-seam.test.ts.
- `pnpm check:capabilities` ✓; lint clean (no source change).

## Seam

The contacts → consumer seam (a resolved contact becomes a gated email
recipient, never-guess) already composes end-to-end in
**p11-email-contacts-seam.test.ts** (goal 700): `muse contacts add Bob`
→ `muse email send --to Bob` over one store sends on confirm, and TWO
same-name contacts ⇒ no send. No additional seam test is needed.

## End-to-end (live, falsifiable test)

Re-ran `muse contacts` against a real `~/.muse/contacts.json`:
- `muse contacts add Bob --email bob@example.com --alias Bobby`;
- `resolve Bob` AND `resolve Bobby` → "Bob (aka Bobby) —
  bob@example.com" (resolves by name AND alias);
- add a SECOND "Bob" → `resolve Bob` is AMBIGUOUS, lists both
  candidates — **never a guessed address**;
- `resolve Carol` → not-found.
The never-guess recipient rule (`outbound-safety.md` rule 3) holds
live.

## Status

**PASS.** P13's resolver does what outbound safety needs: a unique
match resolves, an ambiguous/unknown name clarifies rather than
guessing, and that property holds both in the resolver's piece-checks
and end-to-end through the real store + the gated email consumer. No
drift; no bullet reopened. A `P13 audit — … — PASS` line is appended to
the `docs/goals/README.md` Rejected ledger.

## Decisions

- **No new seam test** — the resolver's own checks + the existing P11
  consumption seam (700) already cover composition; a redundant test
  would be inward churn.
- **Live check is local + free** — contacts is a local JSON store, so
  the end-to-end dog-food needs no network/credential.
- **Audit is steering upkeep** — `docs(loop)`, not a counted iteration;
  no source change.

## Remaining

- **P14–P16 audits pending** — one per iteration, oldest first (P14
  next). After all are audited, extend OUTWARD-TARGETS toward the
  north star.
