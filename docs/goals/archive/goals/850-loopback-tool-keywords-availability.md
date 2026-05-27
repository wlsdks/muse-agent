## 850 — feat: loopback tools can declare relevance keywords; calendar availability is selectable for "am I free?"

## Why

The calendar `availability` tool (827) answers "am I free at 3pm? /
find me a gap / am I busy?" — but it was UNREACHABLE for those exact
prompts. Loopback tools could only declare a `domain`, and the calendar
domain heuristics are `calendar/meeting/event/appointment/…` — none
match free/busy vocabulary. So `DefaultToolFilter` dropped every
calendar tool for "am I free?", and the local model never saw
availability (the #1 one-shot-selection concern). Root cause: the
loopback projection (`McpRemoteTool` → `createMcpMuseTool`) carried
`domain` but had NO way to forward per-tool `keywords`.

## Slice — infra (per-tool keywords) + the availability fix

`@muse/mcp`:
- `McpRemoteTool` gains `keywords?: readonly string[]`;
  `createMcpMuseTool` forwards it to `MuseToolDefinition.keywords`; and
  `createLoopbackMcpMuseTools` (the production projection) passes it
  through. Loopback tools (calendar/tasks/notes/…) can now declare
  relevance keywords — they couldn't before.
- `loopback-calendar.ts` `availability` declares
  `keywords: free / busy / available / availability / gap / slot / 한가`.
  Per-tool, so a generic word ("feel free…") exposes ONLY availability,
  not the whole calendar domain (keeps the exposed set small,
  tool-calling.md rule 1).

## Verify

- `@muse/mcp` mcp-tool-keywords.test.ts (2): `createMcpMuseTool`
  forwards declared keywords to the definition; omits them (no empty
  array) when absent.
- `@muse/autoconfigure` availability-relevance.test.ts (5), the REAL
  `createLoopbackMcpMuseTools(createCalendarMcpServer(…))` → REAL
  `DefaultToolFilter`: "am I free at 3pm?", "free time", "find a gap",
  "am I busy?" all surface `muse.calendar.availability`; a plain
  calendar prompt still surfaces `list` (domain intact); a "feel free…"
  false-positive exposes ONLY availability (not list/add); an unrelated
  prompt surfaces none.
- **Mutation-proven**: dropping the keyword forward in
  `createMcpMuseTool` fails BOTH the unit test AND the end-to-end
  availability-surfacing test — the projection is exactly what makes it
  selectable. `@muse/mcp` 905/905, `@muse/autoconfigure` 239/239, `pnpm
  check` EXIT 0 (0 non-voice failures), `pnpm lint` 0/0.
- Model-facing tool catalog changed (availability now exposed for
  free/busy). EXPOSURE is verified end-to-end; the live SELECTION (Qwen
  picks availability for "am I free?") is `[UNVERIFIED-LIVE]` — Ollama
  down.

## Decisions

- **Per-tool keywords, not domain keywords** — adding "free"/"busy" to
  the calendar DOMAIN would flood all 6 calendar tools on any "free"
  prompt; a per-tool keyword limits a generic-word false-positive to
  the ONE relevant tool. This is why threading per-tool keywords
  through the loopback projection (the infra gap) was the right fix,
  not a one-line domain-keyword add. CAPABILITIES line under P18
  tool-calling reliability.
