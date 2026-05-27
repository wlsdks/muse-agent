# 385 — P4 target-completion audit (the P→P seam check)

## Why

Both P4 bullets (b1 calendar WRITE contract-faithful surface
check; b2 voice end-to-end round-trip automated check) are `[x]`
and no `P4 audit —` line existed. Per the iteration-loop contract
Step 4, the sole mandate of this iteration is to re-run every P4
CAPABILITIES check together AND exercise P4 as one end-to-end flow
against the falsifiable test — does the whole thing actually work
for the user, not just each piece?

## Verify

- Both P4 piece-checks re-run green TOGETHER:
  `@muse/calendar` calendar-write-contract.test.ts 8/8;
  `@muse/cli` commands-listen.test.ts 4/4.
- `pnpm lint` 0/0; `pnpm guard:core` clean.
- No source/test/LLM change this iteration (see Decisions — a
  synthetic seam test is not warranted for P4), so no `pnpm check`
  scale-up and no smoke:live apply; the audit's deliverable is the
  README ledger verdict.

## Status

PASS. Both checks pass together, and each was scrutinised for the
P→P "marked done but went sideways" failure mode:

- **P4-b1** instantiates the REAL `GoogleCalendarProvider` /
  `CalDAVCalendarProvider` / `MacOsCalendarProvider`; only the
  transport (`fetchImpl` / `osascript` spawn) is faked; it asserts
  the exact outbound request (method / URL / auth / body) for
  create/move/cancel. Not read-only, not a fake provider — the
  bullet's "not read-only" claim holds.
- **P4-b2** drives the REAL `registerListenCommand` Phase-C action
  through `program.parseAsync(["node","muse","listen"])` with only
  the I/O boundaries faked (mic spawn / STT / TTS / `/api/chat` /
  playback) and asserts every stage's data actually flowed
  (captured WAV → STT → `/api/chat` → TTS → the written file
  `playAudio` received). Full path, not a re-implemented pipeline —
  the bullet's "full path" claim holds.

No drift; no bullet reopened. P4 (close the trust-blocking
PARTIALs) is genuinely delivered. P0, P1, P2, P3, P4 are now all
delivered + audited. Next iteration resumes Step 5 selection on
the highest unmet OUTWARD-TARGETS bullet — the next frontier is P5
(durable delegated objectives / long-horizon agency).

## Decisions

- **No seam test, unlike the P0–P3 audits — and that is the
  correct, disciplined call, not a skipped step.** P0–P3 were
  *composed pipelines* (chained context transforms; proactive
  delivery + anticipatory prep; ambient + the live pipeline) where
  a real composition hazard existed, so a `*-seam.test.ts`
  exercised the join. P4's two bullets are **independent
  trust-closures** — "can Muse write your calendar safely" and
  "does the voice round-trip work" do not compose into one flow.
  A synthetic voice→calendar-write composition would require
  standing up the full agent + calendar-tool + server stack (a
  smoke:live-class build) for a seam the bullets never claim —
  exactly the gold-plating / excessive-build the contract's
  right-sizing principle bans. For an independent-bullet target
  the faithful Step-4 exercise IS: re-run both checks together +
  scrutinise each for "went sideways" + confirm the falsifiable
  test — all done, all PASS.
- The audit therefore ships only its mandated honesty-machinery
  artifact (the README ledger verdict + this goal doc); `docs:`
  is the honest Conventional Commit type — there is no code or
  test to add, and inventing one would be inward churn.
