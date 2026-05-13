# Episodic memory cross-session recall

Status: **all 5 steps shipped + persona surfacing + LLM-judge
paraphrase recall.** Audit finding #26 (Tier 3). The chain
captures + surfaces + manages prior-session summaries:

- Step 1 — `~/.muse/episodes.json` store in `@muse/mcp`
  (`personal-episodes-store.ts`) — same shape as the followups /
  tasks stores, vacuum-trimmable.
- Step 2 — `[SESSION_BOUNDARY]` sentinel written to
  `last-chat.jsonl` at REPL boot via `appendSessionBoundary` in
  `apps/cli/src/chat-history.ts`. Filtered out of the seed-history
  reader so it never leaks into the next turn's context.
- Step 3a — `extractCurrentSessionTurns` + `summariseSession` in
  `@muse/agent-core/src/episodic-summariser.ts` (pure logic;
  fails soft on transport / parse / empty output). Includes
  secret-scrubbing for OpenAI / Anthropic / GitHub / Google /
  OAuth API key shapes.
- Step 3b — REPL exit hook (`captureEndOfSessionEpisode`) wires
  it together; gated by `MUSE_EPISODIC_MEMORY_ENABLED=true`.
- Step 4 — persona surfacing. `buildMusePersona` renders up to
  `MUSE_EPISODIC_MEMORY_MAX_ENTRIES` (default 20) episodes with
  `topics` tags inline so the LLM can paraphrase-match across
  prior sessions.
- Step 5 — `muse episode list|show|remove|clear|search` CLI +
  `muse.episode.{list,search,show,remove,clear}` MCP loopback.
  Search supports `mode: "substring" | "llm-judge"` — the
  LLM-judge mode replaces the originally-designed vector-RAG path
  (see "Substantive design change" below).

**Substantive design change** vs. the original spec: this doc
originally called for pgvector + an embedding index for
semantic recall. After dogfooding on the personal-agent scale
(≤ a few hundred episodes lifetime), we decided in-context
expansion + LLM-judge retrieval beats vector RAG: zero
infrastructure cost, no manual input UX, paraphrase recall via
the model's native synonymy. The original RAG plan was scrapped;
the `mode: "llm-judge"` path closed the same gap with one extra
generate call per query.

The original "Generation" / "Storage" / etc. sections below
preserve the design rationale and are kept for reference.

## The problem

Audit verdict: **AMNESIA by default.** `muse chat -i` without `-c`
starts with empty history. With `-c`, loads the last 12 turns from
`last-chat.jsonl`. Beyond that, nothing crosses session boundaries —
the LLM-compaction step exists (`HISTORY_COMPACT_THRESHOLD=60`) but
the compacted summary is ephemeral per session, never promoted into
durable memory.

The recentTopics injection that landed in commit `a0c846d` is the
first half: the agent now sees *what subjects* the user has worked
on. The other half is *what was said about each*. Today there's no
mechanism — every `muse repl` starts fresh.

## Goal

A `muse chat` invocation without `-c` still has empty turn history,
but the agent's persona block includes a compacted episodic-memory
section the model can lean on. Conversations across days share
context without leaking full transcripts (privacy + token cost).

## Surface

New persona section in `buildJarvisPersona`, surfaced when episodic
memory is populated for the user:

```
Episodic memory (recent prior sessions, summarized):
  - 2026-05-12: Discussed Q3 budget memo — user decided to draft
    in Notion, deadline Friday. Open question: who reviews?
  - 2026-05-11: Wedding venue shortlist — three candidates,
    user leaning toward downtown.
  - 2026-05-10: Set up muse routine. User active hours 9/14/20.
```

Each entry is one summarized previous session, cap at 5 entries
(configurable via `MUSE_EPISODIC_MEMORY_MAX_ENTRIES`).

## Generation

End-of-session hook scans `last-chat.jsonl` for the turn range that
belongs to the just-finished session (delimited by a sentinel line
the REPL writes at boot). The hook calls a small extraction prompt:

```
System: Summarize the following conversation in <= 60 words.
Capture: (a) what subject was discussed, (b) what the user
decided / where it stands, (c) any explicit follow-up they
asked for. Drop pleasantries.

User: <conversation transcript>
```

Output gets stored in `~/.muse/episodes.json`:

```json
{
  "version": 1,
  "episodes": [
    {
      "id": "ep_…",
      "userId": "stark",
      "startedAt": "2026-05-12T22:00:00Z",
      "endedAt": "2026-05-12T22:18:00Z",
      "summary": "Discussed Q3 budget memo. User decided to draft in Notion, deadline Friday. Open question: who reviews?",
      "topics": ["Q3 budget memo"]
    }
  ]
}
```

## Retrieval

`buildJarvisPersona` picks up the 5 most-recent episodes for the
user. Episodes are sorted by `endedAt` desc, capped, and rendered
with their date stamp.

For higher-fidelity recall (a future iter), introduce a vector
index over episode summaries so the persona block can show the
*most-relevant* episodes for the current prompt — not just the
most-recent.

## Opt-in / privacy

Default **off** for v0. Two env flags:
- `MUSE_EPISODIC_MEMORY_ENABLED=true` — turn on capture.
- `MUSE_EPISODIC_MEMORY_LLM_BUDGET_PER_DAY` — cap LLM calls used
  for summarisation (default 20).

`~/.muse/episodes.json` is local-only, never uploaded. User can
`cat` to audit, `muse episode list` / `muse episode remove <id>`
/ `muse episode clear` to manage.

## Why not extend `recentTopics`

`recentTopics` is a `string[]` of topic labels (auto-extracted
keywords). Episodes are full short narratives with date, decision,
open-question structure. Both belong in the persona block — topics
for breadth ("what has this user been working on"), episodes for
depth ("what was decided in that session"). They feed each other:
the topic-extractor can pull from episode summaries instead of
re-scanning raw transcripts.

## Failure modes

- **LLM call fails during summarisation.** Fail-soft: skip the
  episode, never persist a partial. The next session captures fine.
- **Privacy-bearing turns** (user pasted a token). The summariser
  prompt explicitly says "redact secrets / tokens / API keys."
  Belt + braces: a regex post-pass scrubs strings matching
  `(sk-|gh[pso]_|ya29\.)\S+`.
- **Episode bloat.** Cap `episodes.json` at 500 entries by
  end-of-day vacuum: drop oldest beyond cap.

## Implementation order (4-5 iters)

1. **Store + types** — `~/.muse/episodes.json` CRUD, same shape
   as tasks-store. Direct unit tests.
2. **REPL session sentinel** — `last-chat.jsonl` gets a
   `{ role: "system", content: "[SESSION_BOUNDARY]" }` line at
   boot so the extractor knows what range belongs to which
   session.
3. **End-of-session hook** — when REPL exits, scan from the most
   recent sentinel to EOF, call summariser, persist.
4. **Persona surfacing** — `buildJarvisPersona` reads episodes,
   renders the new section. Tests cover empty / 1 / 5+ episodes.
5. **CLI surface** — `muse episode list/show/remove/clear`.

## Out of scope

- Vector-index relevance retrieval (separate iter).
- Cross-machine episode sync (single-machine local store).
- Voice mode integration — voice sessions can land later via
  the same store once boundaries are defined.
