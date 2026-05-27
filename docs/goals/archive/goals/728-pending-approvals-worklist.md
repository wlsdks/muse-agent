# 728 — P17 remote: pending-approval worklist (`muse approvals`) — the structured substrate for the approve-completion round-trip

## Why

719 records a channel refusal to the immutable action LOG (human-readable
audit). But the approve-completion round-trip (the open `[ ]` P17 bullet)
needs the STRUCTURED action — `tool` + `arguments` + channel — to re-run
it once the user approves, and the action log can't be re-run from. This
ships that substrate as a complete, usable capability on its own: a live,
dismissable, auto-expiring pending-approval worklist, surfaced via
`muse approvals`. The re-run wiring (an inbound "yes" → re-fire) is the
remaining slice; it has no clean existing seam (no "invoke one tool by
name+args with approval" API), so it's deliberately left for a dedicated
next tick rather than half-built here.

## Slice

- `packages/messaging/src/pending-approval-store.ts` (new): pure file
  store — `recordPendingApproval` (capped 200), `listPendingApprovals` /
  `filterUnexpired` (un-expired, newest-first, optional channel scope),
  `clearPendingApproval` (by id, prunes expired). Tolerant read, atomic
  fsync+rename write, corrupt file quarantined. `@muse/shared`-free.
- `channel-approval-gate.ts`: `ChannelApprovalRefusal` gains `arguments`
  (the gate already had `toolCall.arguments`) so a refusal carries
  re-run data.
- `@muse/autoconfigure`: `resolvePendingApprovalsFile` (~/.muse/
  pending-approvals.json, env-overridable).
- `apps/api`: `createChannelPendingRecorder` writes the refusal to the
  store with a 24h TTL; `server.ts` runs it alongside the audit-log
  recorder on every channel refusal (`Promise.allSettled` so one store
  failing can't drop the other; the gate's deny holds regardless).
- `apps/cli`: `muse approvals [list]` + `muse approvals clear <id>`.

## Verify

- `@muse/messaging` pending-approval-store.test.ts (223): record/list/
  scope/newest-first/clear/tolerant-read; **expiry mutation-proven**
  (neutering the `expiresAt > now` filter fails the expired-hidden tests).
- `@muse/api` channel-pending-recorder.test.ts (299): a gate refusal →
  one pending entry with the re-run args + a TTL expiry; expires after
  TTL; delegates to the injected writer.
- `@muse/cli` commands-approvals.test.ts (1277): list newest-first /
  empty / expired-hidden / clear + unknown-id→exit 1 / `--json`.
- **Dog-fooded**: seeded a pending entry → `muse approvals` listed it
  with structured detail; `muse approvals clear demo1` dismissed it;
  empty store → "No pending approvals.".
- `pnpm check`: EXIT=0. `pnpm lint`: 0/0. `pnpm check:capabilities`: ✓.
- No LLM request/response path touched — the gate's decision is
  unchanged; it just persists an extra (fail-soft) record on deny.

## Decisions

- **Distinct from the action log, not redundant** — the action log is an
  immutable audit of every attempt (human strings); this is a LIVE,
  dismissable, expiring worklist holding the structured re-run payload.
  Different lifecycle, different purpose, and the necessary substrate for
  re-run.
- **Store in `@muse/messaging`** — both `apps/api` (writer) and `apps/cli`
  (reader) depend on it, and it's channel-domain; keeping it
  `@muse/shared`-only avoids any agent-core/mcp coupling.
- **24h TTL** — a stale approval shouldn't linger or fire weeks later; the
  worklist auto-expires and `clear` prunes, so it self-cleans.
- **Re-run deferred, bullet left `[ ]`** — re-executing a gated tool from
  an inbound reply is safety-critical and has no existing seam; shipping
  the substrate complete-and-used now (never dead code: gate writes, CLI
  reads/dismisses) beats half-wiring an unverified re-run.
