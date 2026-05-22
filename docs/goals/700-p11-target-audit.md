# 700 — P11 target-completion audit (the P→P seam check)

## Why

P0–P10 are audited; P11 (email — the single biggest missing surface)
is the next oldest completed target with no `P11 audit —` line. Per
the iteration-loop PROCEDURE Step 4, the sole mandate is to re-run
every P11 `CAPABILITIES.md` check TOGETHER AND exercise P11 as one
end-to-end user flow against the falsifiable test.

P11's bullets:
- read/triage/summarise the inbox + needs-reply feeds the briefing
  (694 read; 695 briefing-feed);
- send obeys outbound-safety: draft-first, fail-closed, recipient
  resolved, action-logged (696).

## Verify (all re-run green TOGETHER)

- `@muse/mcp` 20/20 — email-provider (Gmail read + `summarizeInbox` +
  `unreadBriefingLine`), email-send (fail-closed `sendEmailWithApproval`:
  confirm→send / deny / timeout / ambiguous / unknown / no-email),
  situational-briefing-loop (unread inbox grounds a non-empty brief).
- `@muse/cli` 11/11 — commands-inbox, commands-email, commands-contacts
  surfaces.
- `pnpm lint` 0/0; `pnpm check:capabilities` ✓.

## Seams

- **inbox-unread → P8 briefing** already composes in
  situational-briefing-loop.test.ts: a real `EmailProvider` →
  `unreadBriefingLine` → `composeSituationalBriefing` → delivered over a
  real `TelegramProvider` (HTTP faked).
- **contacts → gated send** had no end-to-end home (commands-contacts
  and commands-email are tested with separate contact files). New
  **apps/cli/src/p11-email-contacts-seam.test.ts** drives the real CLI
  commands over ONE `~/.muse/contacts.json`:
  - `muse contacts add Bob --email bob@example.com` then `muse email
    send --to Bob` → resolves + the gated send fires on confirm;
  - TWO same-name "Bob" contacts → `muse email send --to Bob` is
    AMBIGUOUS, NO send, exit 1 — even with an approving gate. The
    never-guess recipient rule (`outbound-safety.md` rule 3) holds
    end-to-end through the real store + `resolveContact` + the
    fail-closed `sendEmailWithApproval`.

## Status

**PASS.** P11's read / briefing / send slices ARE a composed
capability: an inbox is read + triaged, unread items feed the proactive
briefing, and a send to a person resolves the recipient from the
contacts graph and only fires after explicit confirmation — with the
never-guess rule enforced end-to-end. No drift; no bullet reopened. A
`P11 audit — … — PASS` line is appended to the `docs/goals/README.md`
Rejected ledger.

## Decisions

- **New seam test only for the uncovered seam** — the inbox→briefing
  seam already composes in an existing test, so the audit only adds the
  contacts→send CLI seam (which composed nowhere); re-running the rest
  together is the audit, not new tests (avoids inward churn).
- **Audit is steering upkeep** — `docs(loop)`, not a counted iteration;
  the only code is a seam test.
- **Live note** — email read/send live use needs a real Gmail OAuth
  token; the bullet's checks are contract-faithful HTTP fakes
  (delivered), and the seam test uses an injected approve gate +
  recording sender, so no live token is needed for the audit.

## Remaining

- **P12–P16 audits pending** — one per iteration, oldest first (P12
  next). After all are audited, extend OUTWARD-TARGETS toward the
  north star.
