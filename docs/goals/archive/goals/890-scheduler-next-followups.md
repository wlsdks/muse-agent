# Goal 890 — `muse scheduler next` includes scheduled followups

## Outward change

`muse scheduler next` ("what's scheduled to fire next, soonest
first") now merges **scheduled followups** alongside scheduler jobs
and pending reminders. A self-queued promise — "I'll check back in
30 minutes" captured by the followup hook — fires at its
`scheduledFor` exactly like a reminder, yet was invisible in the
unified "what's next" view. It now appears interleaved by instant,
tagged `[followup]`.

## Why this, now

An exhaustive-list seam: `scheduler next` claimed to show what's
scheduled to fire but enumerated only two of the three timed-firing
sources. Followups have their own `muse followup list`, but the
whole point of `scheduler next` is the *unified* soonest-first
answer — omitting a firing class defeats it, and a user trusting
"nothing's next" could miss an imminent followup. Same seam class as
the export-manifest / corpus-source omissions (878 / 866).

## How

The `next` action's `Promise.all` gains a third source:
`readFollowups(resolveFollowupsFile(env))` (followups are a
local-only store with no REST surface, so this reads the file
directly; fail-soft to `[]`). Only `status: "scheduled"` entries are
merged (fired/cancelled excluded), mapped to a `PreviewEntry`
(`kind: "followup"`, `when: scheduledFor`, `label: summary`). The
`PreviewEntry` kind union gains `"followup"`; the existing
instant-based `comparePreviewEntriesByWhen` sort and the
`[${kind}]` renderer need no other change.

## Verification

`apps/cli` `commands-scheduler-setup.test.ts`:
- `comparePreviewEntriesByWhen` interleaves a `followup` between a
  reminder and a job by instant.
- An integration test drives `muse scheduler next --json` with a
  temp `MUSE_FOLLOWUPS_FILE` holding one `scheduled` and one
  `cancelled` followup (jobs/reminders API faked empty), asserting
  the scheduled one appears as a `followup` entry and the cancelled
  one does not — exercising the real `readFollowups` +
  `resolveFollowupsFile` path, not a stub.

Mutation-proven: deleting the followup merge loop fails the
integration test. Cross-package (@muse/mcp + @muse/autoconfigure)
→ `pnpm check` exit 0 (apps/cli 1549). No LLM path → no smoke:live
(Ollama down regardless). `pnpm lint` 0/0.

## Decisions

- Read followups locally rather than via API: there is no followups
  REST surface (`muse followup` is local-only by design), so the
  local read is the only way to surface them — consistent with how
  `muse followup list` already works.
- Only `scheduled` status merges: `fired`/`cancelled` are not
  "next".
