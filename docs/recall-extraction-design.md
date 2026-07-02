# Design: extract grounded-recall presentation/orchestration out of `commands-ask.ts`

Status: SHIPPED through phase 3 (2026-07-03). Phase 1 8782e6d1; retrieval-corpus
core 63295fc8b; stage modules + injected runtime a8a9d60ae; `runGroundedRecall`
seam + `POST /api/ask` + parity/fabrication tests + the
`verify-grounded-recall-seam` live battery in the same session. Remaining
follow-up: retrofit the CLI's `registerAskCommand` sequencing onto the seam
(it already consumes the same stage functions).

## Problem (restated with evidence)

`apps/cli/src/commands-ask.ts` is 3,912 LOC. It splits into:

- **~66 helper functions / ~1,770 LOC** (lines ~89–1772) — presentation,
  selection, and source-adaptation logic for grounded recall. All exported,
  each called from a single internal site.
- **`registerAskCommand` / ~2,140 LOC** (lines 1773–3912) — one function: ~20
  commander options + an `.action()` handler with the entire ask pipeline
  inlined (retrieve → adapt → rank → build prompt → stream → enforce citations
  → verify grounding → present receipts → redraft → record weakness).

The grounding **engine** already lives correctly in
`@muse/agent-core/knowledge-recall.ts` (abstract over `KnowledgeChunk`/
`KnowledgeMatch`; depends only on `tools` + sibling modules — NOT on
mcp/calendar/memory). What leaked into the CLI is the layer **above** the
engine: turning concrete sources (Contact, CalendarEvent, MemoryFact, notes,
episodes) into engine inputs and formatting engine outputs for the user.

Consequence: Muse's core edge (grounded, cited recall) is **not reusable by the
API surface**, violating the "server/CLI/future surfaces share the runtime"
contract in `CLAUDE.md`. And the helpers are exported only to be unit-tested —
the real behavior (how they're sequenced) hides in a 2,140-line function with
no locality.

## Target architecture

A new package **`@muse/recall`** sitting above `agent-core`, below `cli`/`api`.

```
agent-core/knowledge-recall.ts   ← ENGINE (abstract chunks/matches, the gate)
            ▲
@muse/recall                     ← NEW: source-adaptation + presentation + orchestration
   deps: agent-core, mcp, calendar, memory, shared
            ▲
apps/cli (registerAskCommand)    apps/api (ask route)   ← THIN callers
```

Why a new package and not `agent-core`: the leaked helpers need concrete types
from `mcp` (`Contact`, `PersistedTask`, `ActionLogEntry`), `calendar`
(`CalendarEvent`), and `memory` (`MemoryFact`). `agent-core` must stay the
model-agnostic engine and **must not** gain a dependency on `mcp`/`calendar`
(that inverts the layering and couples core to peripheral data packages). A new
package is the only placement that keeps the engine pure AND gives the
presentation/orchestration a reusable home.

### The seam (interface the CLI/API depend on)

```ts
// @muse/recall — the deep entry point (Phase 3)
export interface GroundedRecallInput {
  readonly query: string;
  readonly sources: ResolvedSources;      // notes index, contacts, episodes, tasks, calendar, action-log
  readonly options: RecallOptions;        // topK, scope, tier, opt-ins (shell/git), calendarDays…
  readonly runtime: RecallRuntime;        // model generate/stream, embedder, clock, abort signal
}
export interface GroundedRecallResult {
  readonly answer: string;                // citation-enforced, gate-verified
  readonly verdict: GroundingVerification;
  readonly citations: readonly string[];
  readonly receipts: readonly SourceReceipt[];
  readonly stalenessWarning?: string;
  readonly suggestedActions: readonly GroundingAction[];
  readonly clarification?: RecallClarification;
}
export function runGroundedRecall(input: GroundedRecallInput): AsyncIterable<RecallEvent>;
```

The CLI command becomes: parse options → resolve sources → `runGroundedRecall`
→ render events via `ProgramIO`. The API ask route calls the same function and
serializes the result. Streaming stays a concern of the caller (the CLI streams
to a terminal, the API to SSE); the pipeline yields structured `RecallEvent`s.

## Function placement (the 66 helpers, categorized)

| Tier → target module | Functions (representative) | Moves? |
|---|---|---|
| **Pure presentation** → `recall/present.ts` | `provenanceSnippet`, `relevantSnippet`, `formatCoarseAge`, `formatStalenessWarning`, `collectCitedNoteAges`, `formatSourcesFooter`, `groundingSectionLines`, `provenanceDate`, `stripEchoedCiteAs`, `answerIsRefusal`, `urlGroundingSource`, `formatGraphLinksSection`, `relativizeNoteSource`, `looksLikeBinaryContent`, `renderAskStreamError` | **Phase 1** |
| **Source selection/adaptation** → `recall/select.ts` | `selectMemoryFacts`, `allUserMemoryFacts`, `renderMemoryFact`, `rankEpisodeHits`, `recentFeedHeadlines`, `selectGroundingActions`, `selectFilePassages`, `selectProbationSuggestion`, `contactMatchScore`, `contactGroundingEvidence`, `formatContactBirthday`, `diversifyAskChunks`, `notesGroundingFraming`, `buildAskConnections`, `selectGraphConnections`, `filterNotesByScope`, `augmentNoteEvidenceWithCited`, `formatSourceReceipts`, `formatNonNoteReceipts`, `selectPlaybookSection`, `topAppliedStrategy`, `composeChatSystemContent` | **Phase 2** |
| **Model-backed gate wrappers** → `recall/verdict.ts` | `drawBestGroundedRedraft`, `groundingVerdictNotice`, `shouldSuggestRepair`, `shouldWarnStrippedCitations`, `suggestOptInSource` | **Phase 2** |
| **Weakness ledger** → `recall/weakness.ts` | `recordAskWeakness`, `recordAskWeaknessResolved`, `askOutcomeLabel`, `askWeaknessAxis` (already deps-injected) | **Phase 2** |
| **Consts** → `recall/copy.ts` | `CASUAL_RESPONSES`, `META_RESPONSE`, `ACTION_GUIDE`, `CITATION_INSTRUCTION_LINES`, `REASONING_PRINCIPLE_LINES`, `WARM_REFUSAL_CLOSE`, `NOTES_ONLY_TOOL_ALLOWLIST`, `RECALL_FORBIDDEN_TOOL_NAMES` | **Phase 1** |
| **Orchestration** → `recall/pipeline.ts` | the pipeline body lifted out of `registerAskCommand` as `runGroundedRecall` | **Phase 3** |
| **STAYS in CLI** (I/O, option parsing, terminal stream) | `loadImageAttachment`, `listNoteFiles`, `notesCorpusFileCount`, `parseBoundedInt`, `resolveAskMaxTools`, `resolveAskTierModels`, `routeAskTierModel`, `consumeAskStream`, `registerAskCommand` shell | — |

CLI-local types currently consumed by movers (`ScoredChunk`, `RecallHit`,
`NoteLinkGraph`) get a package-owned home (`@muse/recall` defines
`ScoredPassage`; `RecallHit`/`NoteLinkGraph` move from `commands-recall.ts` /
`notes-links.ts` into the package, re-exported to CLI to avoid a churn diff).

## Phasing (each phase independently mergeable + verified)

**Phase 1 — stand up the package + move pure presentation (low risk).**
Create `@muse/recall` (composite project, references `agent-core` + `shared`;
added to root tsconfig + the build-graph rule). Move `present.ts` + `copy.ts`
(no mcp/calendar coupling). Move their tests. `commands-ask.ts` imports from
`@muse/recall` instead of defining them. Net: ~400–500 LOC out of the CLI, a
real package boundary proven. Verify: `pnpm --filter @muse/recall test`,
`pnpm --filter @muse/cli build`, full `pnpm test`.

**Phase 2 — move selection/adaptation + verdict + weakness.** Adds
`mcp`/`calendar`/`memory` to the package deps. Move `select.ts`, `verdict.ts`,
`weakness.ts` + tests. `commands-ask.ts` drops to ~the orchestrator alone.

**Phase 3 — extract `runGroundedRecall` + wire the API.** Lift the pipeline out
of `registerAskCommand`'s action handler into `pipeline.ts` behind the seam
interface; CLI renders its events; add/point the **API ask route** at the same
function. This is the phase that actually closes the contract violation —
ship it with a **parity test**: same `GroundedRecallInput` through CLI and API
adapters yields the same `answer`/`verdict`/`citations`.

## Test strategy

- Tests move WITH the code (they're already pure-function unit tests; placement
  stays this package's `test/` dir).
- New seam-level tests: a terminal-state test that `runGroundedRecall` returns a
  citation-enforced, gate-verified answer for a grounded fixture, and "I'm not
  sure" + zero fabricated citations for an ungroundable one (the fabrication=0
  invariant, asserted at the seam instead of only in the CLI path).
- Phase 3: CLI↔API parity test (above).
- The existing `eval:chat-grounding` / `eval:grounding-delta` live batteries
  must not regress (run after Phase 3).

## Risks & hostile self-review

- **Scope blowout.** The honest risk: Phase 3 is large (a 2,140-line function).
  Mitigation: Phases 1–2 deliver locality+package value on their own and are
  independently mergeable; Phase 3 is the only one that touches the pipeline and
  is gated by the parity + live grounding evals. If Phase 3 proves too entangled
  with terminal streaming, fall back to extracting the pure pipeline *steps* as
  named functions in the package and keeping the sequencing in the CLI — still a
  win, smaller blast radius.
- **Hidden coupling.** Some "pure" helpers may close over module-level consts or
  CLI singletons. Phase 1 will surface these at compile time (composite refs
  fail fast); resolve by moving the const or injecting it — do NOT re-export a
  CLI singleton back into the package (would invert the layer).
- **`@muse/recall` becoming a second god-package.** Guard: it has ONE public
  entry (`runGroundedRecall`) + a focused presentation surface; internal modules
  stay <~600 LOC. If `select.ts` balloons, split by source.
- **Churn vs the running loop.** This touches `commands-ask.ts` heavily; the
  concurrent loop may also edit it. Do each phase as a tight, fast-merged slice
  to minimize the conflict window.
- **Naming.** `@muse/recall` chosen over `@muse/grounded-recall` (shorter) and
  `@muse/grounding` (would imply it owns the engine, which stays in agent-core).
