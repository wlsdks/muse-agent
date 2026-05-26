# Temporal validity timeline for user-memory facts — design spec

- **Date:** 2026-05-27
- **Status:** delivered
- **Direction:** research-based agent-quality upgrade (EXPANSION-PLAYBOOK priority #3)
- **Source idea:** Zep (arXiv 2501.13956) — temporal knowledge graph: facts carry validity; supersede, don't delete.

## Problem

Muse's user-memory file store already records every fact value change as a
`FactSupersession { key, previousValue, replacedAt }` appended to
`UserMemory.factHistory` (capped at 50, atomic on the `~/.muse/user-memory.json`
daily-driver path). But that history is **audit-only** — nothing reads it. When
the user asks "what did I used to set my home city to?" or "when did that
change?", Muse silently shows only the current value. The temporal information
exists; the consumer is missing.

## Goal

Surface the supersession history as a live, user-visible validity timeline
(Zep's "supersede don't delete"), reusing the data already persisted — no
schema change, no new dependency, no model call.

## Non-goals (YAGNI)

- **No** belief-tier revision (Hindsight, arXiv 2512.12818) — that is the
  natural next slice on top of this substrate, not this one.
- **No** change to how supersessions are *recorded* (the file store already
  does it correctly) or to recall/injection.
- **No** Kysely/server work — the live daily-driver surface is the CLI file
  store; the server user-memory path is out of scope here.

## Design

### Pure core — `apps/cli/src/commands-memory.ts`

`buildFactTimeline(facts, factHistory, keyFilter?) → FactTimelineEntry[]`:
```ts
interface FactTimelineEntry {
  readonly key: string;
  readonly current?: string;   // undefined when the fact was later forgotten
  readonly since?: string;     // ISO of the last supersession (when current took effect)
  readonly previous: ReadonlyArray<{ readonly value: string; readonly until: string }>;
}
```
- Group `factHistory` by key (filtered to the normalised `keyFilter` when given).
- Per key: sort history by `replacedAt` asc; `since` = last `replacedAt`;
  `previous` = each prior value with `until = replacedAt`, newest-first.
- Without `keyFilter`: return only keys that actually changed (a never-changed
  fact has no story). With `keyFilter`: always return that key (current +
  any history); a key present only in history (forgotten fact) is included
  with `current` undefined.
- `keyFilter` is run through `normalizeMemoryKey` (re-exported from
  `@muse/memory`) so "Home City" matches the stored `home_city`.

### Surface — `muse memory history [key]`

A new subcommand in the existing `memory` group (mirrors `memory search`):
reads `FileUserMemoryStore.findByUserId(userId).factHistory`, builds the
timeline, prints `key: <current> (since <iso>)` + `  ↳ was "<old>" until <iso>`
lines, or `--json`. `--user` / `--persona` select the identity.

## Testing & verification

- `apps/cli` memory-timeline.test.ts: changed-fact trace (current + since +
  newest-first prior), changed-only listing without a key, never-changed key
  returns current-only, key-filter normalisation, forgotten-fact (history but
  no current), empty.
- LIVE end-to-end: `muse memory set fact home_city Busan --local` →
  `… Seoul --local` → `muse memory history home_city` prints the Seoul/Busan
  validity timeline over the real `~/.muse/user-memory.json`.
- `pnpm --filter @muse/{memory,cli} test`, `pnpm lint` 0/0.

## Decisions

- **Surface existing data, don't re-record.** The supersession log was already
  written correctly and conservatively; the gap was purely the absence of a
  reader. This keeps the slice minimal and risk-free.
- **CLI file store is the live surface.** It is the durable single-user
  daily-driver memory; the server Kysely user-memory path has no validity
  consumer and is deferred.
- **Belief-tier is the next slice.** Hindsight-style beliefs (an inference that
  points to its evidence and is revised on a veto) build naturally on this
  validity substrate but are a distinct unit of work.
