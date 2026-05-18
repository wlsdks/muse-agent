# 388 — Reviewable autonomous-action log (P6-b1)

## Why

OUTWARD-TARGETS P6 ("accountability & correction loop — trust
requires the user can see, undo, and teach. Without this, P4/P5
autonomy is not safely delegable"). P5 made Muse able to act
autonomously on the user's behalf (consented scoped-credential
external actions). P6-b1 is the *see* half: every such action —
performed OR refused — must produce a durable, rationale-bearing
entry the user can review. Without a visible record, delegated
autonomy is unaccountable.

## Slices

- s1 (P6-b1, THIS): `packages/mcp/src/personal-action-log-store.ts`
  — the durable review substrate, same proven posture as the other
  personal stores (atomic fsync+rename, tolerant read, corrupt
  store quarantined aside) but **append-only by contract**: an
  audit log must never lose or rewrite history, so there is no
  upsert/patch — only `appendActionLog` (a duplicate id is still
  appended; the log records *attempts*, not state).
  - `ActionLogEntry` (id / userId / when / what / why / result ∈
    performed|refused|failed / objectiveId? / detail?).
  - `queryActionLog(file, {userId?})` — the review surface:
    newest-first, optionally user-scoped (what `muse actions` /
    an `/api/actions` route renders).
  Verified by `personal-action-log-store.test.ts`, including the
  composed integration: `runDueObjectives` → `performConsentedAction`
  → `appendActionLog` → `queryActionLog`.
- s2 (P6-b2, next): one-tap undo/veto — reverse a logged action
  where reversible AND write a memory veto so the same trigger no
  longer auto-acts.

## Verify

- `packages/mcp/src/personal-action-log-store.test.ts` 5/5 (run
  directly) and within `pnpm --filter @muse/mcp test` (425 pass).
- tsc strict clean (ran proactively); `pnpm check` green across
  all workspaces (apps/cli 683, all packages); `pnpm lint` 0/0;
  `pnpm guard:core` clean.
- No request/response (LLM) path touched — pure durable data
  layer + composition with the existing autonomous-action path;
  the bullet's mandated check is "(smoke/integration)", which is
  the composed integration test. No smoke:live applies.

## Status

P6-b1 done. The bullet's check ("an autonomous action produces a
rationale-bearing log entry on the user surface") is delivered
end-to-end: a met objective drives the real consented action and
`appendActionLog` records `{ what: "POST <url>", why: <objective
spec>, when, result: performed, detail: "HTTP 201" }`, which
`queryActionLog({userId})` returns to the user newest-first. A
fail-closed refusal is logged too (`result: refused`, detail =
the consent reason) — accountability covers what was NOT done.
Append-only, missing/corrupt tolerance, and user-scoped newest-
first query are all covered. P6-b1 flipped `[ ]`→`[x]`; one
CAPABILITIES line appended; README backlog row added.

P6-b2 stays `[ ]` (separate bullet, separate slice).

## Decisions

- **Append-only, not upsert** (unlike objectives/consents which
  replace-on-id): an accountability log that can rewrite or drop
  history is not an accountability log. A duplicate id is appended,
  not deduped — it records attempts.
- Refusals are first-class log entries (`result: "refused"`): "the
  log records every autonomous action" includes the ones a guard
  blocked — the user must be able to see Muse *declined* to act and
  why, not just what it did.
- `queryActionLog` IS the queryable user surface the bullet's check
  names; a `muse actions` CLI / `/api/actions` route is a thin
  follow-up over it, not required by this bullet's check and not
  gold-plated in.
- The integration composes the store with the REAL autonomous
  path (`runDueObjectives` → `performConsentedAction`) rather than
  calling the store in isolation, so the test proves entries are
  produced *by an autonomous action*, which is what the bullet
  asserts.
- `feat(mcp)`: a new user-world capability (the user can review
  what Muse did/declined on their behalf and why).
