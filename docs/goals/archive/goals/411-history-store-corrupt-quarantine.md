# 411 — Corrupt-store quarantine for the two history audit logs

## Why

Data-safety consistency hardening of an existing durability
posture (a different axis from the recent
CLI/feeds/policy/briefing cluster).

The personal-store family has a documented durability contract:
"tolerant read (missing/bad-JSON → []), corrupt store quarantined
aside (`<file>.corrupt-<ts>`)". An audit across all 12 mcp
`personal-*-store.ts` modules found **10 quarantine** a
present-but-corrupt file before degrading to `[]`, but **2 did
not**:

- `personal-proactive-history-store.ts`
- `personal-reminder-history-store.ts`

Their `readRaw` returned `[]` on a `JSON.parse` failure / bad
shape with no quarantine. The very next `append*History` writes a
fresh file via tmp+rename — **permanently destroying** the
corrupt-but-forensically-recoverable bytes. Their own docstrings
state these are append-only audit logs so the user/agent can
review "did Muse actually push the 3pm meeting notice?" *weeks
later* — silently shredding that history on a partial-write /
disk-glitch corruption directly defeats the feature's stated
purpose, and diverges from the contract its 10 siblings honour.

Not cosmetic / not a speculative guard: the divergence is the
defect and its consequence (irrecoverable loss of the user's
accountability trail) is concrete and user-affecting — exactly the
"consistency / robustness / edge cases" class this loop is meant
to deepen.

## Slice

- `packages/mcp/src/personal-proactive-history-store.ts` and
  `packages/mcp/src/personal-reminder-history-store.ts` — add the
  byte-identical `quarantineCorruptStore` helper used by the 10
  sibling stores and call it on BOTH corrupt branches of `readRaw`
  (the `JSON.parse` catch + the shape-invalid guard). A missing
  file still returns `[]` with no rename — absence is not
  corruption (the canonical posture, asserted by a test).
- `packages/mcp/test/mcp.test.ts` — extend the existing
  `corrupt-store quarantine` describe (which already pins
  reminders + followups) with: proactive-history quarantine,
  reminder-history quarantine, and a "missing file is NOT
  quarantined" guard. Mirrors the sibling assertions exactly
  (corrupt → `[]` + one `.corrupt-<ts>` holding the original
  bytes; next append starts fresh; quarantine count stays 1).
  Also dropped the `(goal 190)` marker from the edited describe
  title (rides inside this change; the title now reflects the
  broadened scope — not a standalone sweep).

## Verify

- `@muse/mcp` `corrupt-store quarantine` block 7/7 (4 pre-existing
  + 3 new), the new ones fail on the pre-fix code (no `.corrupt-`
  file is produced).
- `pnpm check` EXIT=0, every workspace green (mcp 488 — was 485,
  +3; api 194; cli 717; …); tsc strict (mcp) clean; `pnpm lint`
  0/0; `pnpm guard:core` clean; byte-scan clean.
- Pure store I/O, no request/response (LLM) path — no
  `smoke:live` applies. mcp is consumed cross-package so the full
  `pnpm check` was the gate (not just the package test).

## Status

Done. A corrupt `proactive-history.json` / `reminder-history.json`
is now moved aside to `<file>.corrupt-<ts>` for manual recovery
instead of being silently overwritten on the next append — the
two stores now honour the same durability contract as their 10
siblings, and the user's autonomous-action audit trail survives a
corruption event.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]`; this is a data-safety hardening of an existing
durability feature, recorded honestly as a `fix(mcp):` change with
this backlog row — not a false metric.

## Decisions

- Mirrored the canonical `quarantineCorruptStore` verbatim rather
  than abstracting a shared helper: a one-iteration extraction
  across 12 stores would be a much larger, riskier refactor for no
  behavioural gain — the tight fix is to make the 2 outliers match
  the 10. A shared-helper consolidation remains a legitimate
  future refactor slice if the duplication is ever judged worth
  centralising.
- Explicitly tested the missing-file path so a future change
  can't regress "absence → spurious `.corrupt` file" (which would
  litter `~/.muse` on every fresh install).
