# 508 — `tsToIso` guards against out-of-range Slack `ts` that would crash the whole `fetchInbound` batch (goal-440/453/459/465 sibling on the Slack inbound wire path)

## Why

`packages/messaging/src/slack-provider.ts:274` exposed an
internal `tsToIso(ts)` helper that converts Slack's
`<epoch_seconds>.<microseconds>` string into an ISO-8601
timestamp. It is called by `SlackProvider.fetchInbound` on
**every inbound message** the Slack-poll daemon ingests:

```ts
receivedAtIso: tsToIso(message.ts),
```

Pre-fix it computed:

```ts
const seconds = Number.parseFloat(ts);
if (!Number.isFinite(seconds) || seconds <= 0) {
  return ts;
}
return new Date(seconds * 1000).toISOString();
```

The guard catches `NaN`, `Infinity`, `0`, and negative values —
but **not** a finite-but-out-of-range `seconds`. JavaScript's
`Date` rejects ms values outside ±8.64e15 (±100M days from
epoch). A Slack `ts` like `"9999999999999999"` (corrupt /
hand-edited / replayed from a malformed payload) yields `seconds
= 9.999...e15`, `seconds * 1000 = 9.999e18` — an Invalid Date
whose `toISOString()` throws `RangeError: Invalid time value`.

The throw propagates up `flatMap` inside `fetchInbound`,
rejecting the **entire batch** of inbound messages — one
poisoned `ts` would silently drop every valid sibling message
in that poll cycle. The Slack-poll daemon would log the error
and lose inbound traffic until the bad message is somehow
purged from the channel feed.

Same 440 / 453 / 459 / 465 defect class — `new Date(<loaded>).
toISOString()` without a finite-Date check on the inbound wire
path. Personal-activity-feed and personal-status-summary
already carry the identical guard pattern (`Number.isFinite(new
Date(ms).getTime())`); the Slack provider was the remaining
outlier on the messaging-ingress side.

## Slice

- `packages/messaging/src/slack-provider.ts` — `tsToIso`
  promoted from internal `function` to `export function` (no
  prior callers outside the file; safe to widen) and a finite-
  Date guard added after the parse:
  ```ts
  const date = new Date(seconds * 1000);
  if (!Number.isFinite(date.getTime())) {
    return ts;
  }
  return date.toISOString();
  ```
  Same fallback shape as the existing `seconds <= 0` branch
  (return the raw `ts` string so downstream sees the unmodified
  Slack value rather than a fabricated ISO).
- `packages/messaging/test/slack-ts-to-iso.test.ts` — new
  file, 5 focused tests covering every fallback branch + happy
  path + the out-of-range RangeError defence.

Behaviour byte-identical for every clean Slack `ts` (normal
seconds in the ~1.7e9 range, zero, empty, non-numeric, Infinity)
— only the out-of-range path is closed.

## Verify

- New test 5/5 green; full `@muse/messaging` suite green
  (171 passed, +5, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the new
  guard back to `return new Date(seconds * 1000).toISOString();`
  makes the out-of-range test fail with the precise pre-fix
  symptom — `RangeError: Invalid time value` thrown from
  `toISOString()` on `new Date(9.999e18)`. Every other test
  stays green. Fix restored, suite back to 5 green.
- `pnpm check` EXIT=0, every workspace green; `pnpm lint` 0/0;
  `pnpm guard:core` clean (no IMMUTABLE-CORE touched); byte-
  scan clean; `git status` shows only the two intended files.
- Pure conversion helper — no LLM request-response wire path;
  `smoke:live` does not apply (per `testing.md` / iteration-
  loop Step 9). The defended path is the messaging-ingress
  daemon, not the model loop.

## Status

Done. A corrupt / out-of-range Slack `ts` no longer crashes
the whole `fetchInbound` batch and silently drops every valid
sibling inbound message. The defect-class convention now reads
identically across `personal-activity-feed.ts`,
`personal-status-summary.ts`, and `slack-provider.ts` —
`Number.isFinite(new Date(ms).getTime())` is the cross-package
finite-Date guard.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a defect-class sibling-asymmetry
`fix:` on the Slack inbound wire path, recorded honestly with
this backlog row — not a false metric.

## Decisions

- Step-8 redirect from the apps/cli lenient-parse run (502 /
  503 / 505 / 507) to a fresh defect class (`new Date(loaded).
  toISOString()` RangeError) on a fresh surface (messaging-
  ingress). Different class on a different area — productive
  variation, not janitorial drift.
- Promoted `tsToIso` to `export` rather than testing through
  `fetchInbound` with a mocked Slack HTTP call: the parse logic
  is the only thing the iteration touches; an end-to-end test
  would couple to fetch / channel iteration / type-narrowing
  plumbing that aren't the contract being pinned. Smaller test
  surface, equally direct coverage of the actual defect. Mirrors
  the goal-502 `parseChatRateLimitCapacity` extract-and-export
  decision.
- Chose the same fallback shape as the existing `seconds <= 0`
  branch (return raw `ts`) rather than throwing or substituting
  the current timestamp: downstream callers already treat
  `receivedAtIso` as advisory, and a fabricated `new Date().
  toISOString()` would silently misattribute a corrupt-ts
  message to the present moment, hiding the corruption from a
  developer reading the inbox sidecar.
- Did NOT add a `Number.MAX_SAFE_INTEGER` check (`seconds <=
  Number.MAX_SAFE_INTEGER / 1000`): the `Number.isFinite(date.
  getTime())` check is the authoritative one — the JS engine
  enforces the actual `Date` range. A separate bound check
  would be sibling drift.
