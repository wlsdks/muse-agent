# 466 — `filterFresh` compares parsed instants — a cross-provider timestamp can't silently drop an inbound message (461/464 sibling, functional)

## Why

`filterFresh` (`@muse/messaging` `inbox-surface.ts`) is **not a
display sort** — it is the gate deciding which inbound messages
are NEW past the per-source cursor and therefore get processed /
injected into the agent. It used lexicographic ISO string
compare in BOTH places:

```ts
const sorted = [...inbox].sort((a, b) => a.receivedAtIso.localeCompare(b.receivedAtIso));
const fresh = sorted.filter((m) => !last || m.receivedAtIso > last); // string ">"
```

`receivedAtIso` is **provider-supplied**, and Telegram / Discord
/ Slack / LINE construct timestamps with different precision /
offset (`"…00.000Z"` vs `"…00Z"` vs `"+09:00"`) — so mixed
formats occur in *normal multi-provider operation*, not just
corruption. Lexicographically `"…00.500Z" < "…00Z"` (`'.'` <
`'Z'`), so a message whose instant is genuinely **newer** than
the cursor but whose string sorts ≤ the cursor evaluates
`m.receivedAtIso > last` as **false** → it is judged "not fresh"
and **silently never processed**. A real user message to JARVIS
via one provider can vanish because the cursor was written by
another. This is the codebase's own standing 418 / 461 / 464
decision (lexicographic ISO compare is wrong; use parsed
instants) at its **highest-stakes instance** — a functional
message-loss gate, not a review-display order — found by the
systematic localeCompare-on-timestamp sweep.

Fresh package (messaging last touched goal 442, ~24 iterations
ago; not the recently-churned mcp). The existing `filterFresh`
tests use only canonical `…000Z` stamps (lexicographic ==
instant), so the cross-provider case was **genuinely uncovered**
and they stay green (no wrong premise). Not manufactured:
deterministic, reachable in ordinary multi-provider use.

## Slice

- `packages/messaging/src/inbox-surface.ts` — both the sort and
  the freshness predicate now use `Date.parse` instants
  (ascending sort; `mm > lm` strictly-newer), byte-parallel to
  goal 461/464's instant-compare; a deterministic `localeCompare`
  / string `>` fallback only when a value is unparseable
  (`Number.isFinite` guarded). `cursor`-less (`!last`) and
  `slice(-perProviderLimit)` semantics unchanged.
- `packages/messaging/test/inbox-surface.test.ts` — a new `it`:
  a cursor `"…08:00:00Z"` (second-precision provider) + a
  genuinely-0.5s-newer `"…08:00:00.500Z"` message
  (millis-precision provider) → it is fresh (`["newer"]`), not
  dropped; plus a `-05:00`-offset cross-provider ordering case
  → `slice(-2)` keeps the two instant-newest in instant order.

## Verify

- New `it` green; the pre-existing canonical-timestamp
  `filterFresh` tests still green (no wrong premise); full
  `@muse/messaging` suite 147 passed (11 files, +1); tsc strict
  (messaging) EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting to the
  lexicographic sort + string `>` makes the new test fail with
  `expected [] to deeply equal ['newer']` — i.e. the
  genuinely-newer cross-provider message is silently dropped
  (returns `[]`); fix restored, suite back to 147 green.
- `pnpm check` EXIT=0, every workspace green (messaging 147,
  cli 743, api …) — no regression; `pnpm lint` 0/0;
  `pnpm guard:core` clean; byte-scan clean; `git status` shows
  only the two intended files.
- Pure deterministic sort/filter logic — no LLM / model
  request-response wire path; `smoke:live` does not apply (per
  `testing.md` / iteration-loop Step 9).

## Status

Done. An inbound message whose provider stamps a timestamp in a
different precision/offset than the one that wrote the cursor is
no longer silently judged "not fresh" and dropped — freshness and
ordering are now instant-based. This is the functional (not
cosmetic) instance of the 418/461/464 class: it stops real
inbound message loss across multi-provider setups.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; an 418/461/464 sibling-asymmetry
correctness `fix:` (functional message-loss), recorded honestly
with this backlog row — not a false metric.

## Decisions

- Fixed BOTH the sort and the freshness predicate: the
  freshness `>` is the message-loss keystone, but a
  lexicographically-mis-sorted list also feeds
  `slice(-perProviderLimit)`, so a per-provider cap could
  otherwise keep the wrong (older) tail. Both must be
  instant-based to be correct.
- Byte-parallel to 461/464 (`Date.parse` + finite-guard +
  string fallback): the instant-compare comparators across the
  codebase must stay one shape (the 413/432 single-source
  anti-drift rationale).
- Surveyed extensively first (csv_parse / base64 / CLI
  parseLimit+Math.clamp helpers / inbox-store — all confirmed
  mature + already covered, nothing manufactured; declined a
  `clampPositive` "fix" as deliberate-by-test in goal 464);
  this systematic-sweep finding is the one concrete reachable
  defect, and the highest-leverage of the recent run.
