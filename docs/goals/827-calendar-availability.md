## 827 — feat: the agent answers "am I free?" — calendar availability

## Why

"Am I free at 3pm?" / "do I have time this afternoon?" / "find a
30-minute gap tomorrow" is one of the most common things you ask a
daily-driver assistant. Muse could `list` events but had NO free/busy
capability — the agent had to fetch events and reason about gaps
itself (unreliable on the local model). This adds a deterministic
free/busy engine + a single-purpose calendar tool.

## Slice

- `@muse/mcp` calendar-availability.ts — pure `computeAvailability(events,
  window, {minFreeMinutes?})`: clamps each event to the window (an
  all-day event blocks its whole span), merges overlapping AND adjacent
  busy intervals (keeping every contributing title), and returns the
  complement free gaps, optionally filtered to a minimum duration. No
  IO — exhaustively unit-testable. Invalid window / zero-length events
  handled safely.
- `muse.calendar.availability` tool (loopback-calendar.ts): `fromIso`
  required (ISO or a relative phrase like 'tomorrow 3pm' / '내일 오후 3시'),
  `toIso` defaults to +60 min, optional `minMinutes`, optional
  `providerId`. Returns `fullyFree`, the `busy` blocks, and the `free`
  gaps. Read-risk, domain "calendar". Description is sharply DISJOINT
  from `list`/`add` ("do NOT use to list everything scheduled / to
  create an event") to protect one-shot selection (tool-calling.md
  rule 2). Calendar domain stays within the ≤7 budget (6 tools).

## Verify

`@muse/mcp` calendar-availability.test.ts (11):
- Pure engine (8): empty→fully free one slot; one meeting→two gaps,
  not free; overlapping+adjacent merge keeping all titles; window
  clamping; `minFreeMinutes` drops short gaps; all-day blocks the
  window; a 1-hour point check reports free; zero-length/inverted
  events + an inverted window ignored safely.
- Tool over the registry (3): exposed as a read tool in the calendar
  domain; answers "am I free" from the registry's events (fullyFree
  false, 1 busy, 2 free); a missing `fromIso` → clear error.
- **Mutation-proven**: changing the merge `<=` to `<` (adjacent events
  no longer merge) → the merge test fails; dropping the `minFreeMs`
  filter → the minFreeMinutes test fails. Full `pnpm check` EXIT 0,
  `pnpm lint` 0/0.
- **Live model SELECTION `[UNVERIFIED-LIVE]`** — adding a tool changes
  the model-facing catalog, so the smoke:live one-shot selection
  round-trip (availability vs list) is the real proof; Ollama is down
  this session, so the handler + pure logic + domain exposure are
  verified and selection is deferred.

## Decisions

- **One tool, one rich answer** — `fullyFree` + `busy` + `free` in a
  single response answers BOTH "am I free at X" and "find a gap" in one
  call, so the local model never has to chain calls (tool-calling.md
  rule 5).
- **Pure engine separate from the tool** — the merge/clamp/complement
  logic is the part worth exhaustive deterministic tests; the tool is a
  thin registry adapter over it. CAPABILITIES line under calendar /
  conversational-actuation (no bullet flip — like the other read tools,
  this is capability the ledger records, not an open OUTWARD-TARGETS
  bullet).
