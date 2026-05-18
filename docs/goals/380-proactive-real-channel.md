# 380 — Proactive delivery proven on a real channel (P2)

## Why

OUTWARD-TARGETS P2 audit: the proactive / followup / reminder
daemons are well-engineered (dedupe, quiet-hours, Phase-D synth)
but EVERY firing test injected a fake registry — unit-only, so no
green check exercised the real channel-delivery surface and P2-b1
could not count under the CAPABILITIES surface-check rule. P1-b2
solved the symmetric gap for *inbound* replies with a
contract-faithful `TelegramProvider` HTTP fake; P2-b1 is the
*outbound proactive* counterpart.

## Slices

- s1 (P2-b1): a contract-faithful surface check that
  `runDueProactiveNotices` delivers an imminent-item notice over a
  REAL `TelegramProvider`'s HTTP send. `apps/api/test/
  proactive-notice-delivery.test.ts` seeds a real tasks store
  (`writeTasks`), wires a real `TelegramProvider` whose only fake
  is the HTTP boundary into a real `MessagingProviderRegistry`,
  runs the daemon, and asserts the outbound POST is exactly the
  Telegram Bot API request (`/botTOK/sendMessage`, `chat_id`,
  notice text) — never a fake registry. A second tick at the same
  clock proves the real dedupe sidecar suppresses a re-POST.

## Verify

- `apps/api/test/proactive-notice-delivery.test.ts` 1/1 (run
  directly) and within `pnpm --filter @muse/api test` (169 pass).
- `pnpm check` green across all workspaces (apps/api 169,
  apps/cli 681, all packages).
- `pnpm lint` 0/0; `pnpm guard:core` clean.
- No request/response (LLM) path touched: the flat-notice path is
  exercised (no `modelProvider`/`agentRuntime` passed), so no
  smoke:live applies — the bullet's mandated check is an
  integration POST assertion, which is what this is.

## Status

P2-b1 done — the proactive daemon's channel delivery now has a
green contract-faithful surface check (not unit-only). P2-b1
flipped `[ ]`→`[x]`; one CAPABILITIES line appended; README
backlog row added.

P2-b2 ("anticipatory prep — 'meeting in 15 min — here's the doc' —
rides this path, ties to P1") is the next slice and stays `[ ]`.

## Decisions

- Drove the daemon via the `tasksFile` route, not a
  `CalendarProviderRegistry`, because `runDueProactiveNotices`
  treats imminent tasks and calendar events identically through
  the same `sendWithRetry` sink — the task route is the smaller
  faithful fixture and exercises the exact delivery seam P2-b1
  names.
- The second-tick dedupe assertion is part of the same test (not
  a separate one) so the surface check proves the *real* sidecar
  participates — a fake registry can fire-and-forget; a real
  delivery path must not double-POST.
- `test:` commit type: the diff is a surface check + ledger docs
  over unchanged production code. It still flips an outward bullet
  and appends a CAPABILITIES line because the bullet's deliverable
  IS "a check asserts the POST" — the verification is the
  capability per the P2 audit note.
