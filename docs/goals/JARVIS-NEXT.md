# JARVIS-NEXT — Iron Man-class capability roadmap (batch 087-096)

This file is the "look at while working" reference for the
batch 087-096 `/goal` autonomous run. Read it once before
starting the loop; revisit when scope feels fuzzy on any
individual goal.

## What's already JARVIS-class in Muse

(Done through goal 086.)

- Multi-provider LLM (OpenAI, Anthropic, Gemini, Ollama, OpenRouter,
  LM Studio, OpenAI-compatible)
- MCP server registry with allowlist + sha256 fingerprint pinning
- Memory: facts / preferences / vetoes / goals; auto-extract from
  every turn, per-user cooldown throttle
- Personal stores: tasks, reminders, followups, episodes, patterns,
  notes (RAG-embedded), user-memory
- Calendar: local + Google + CalDAV + macOS, with failure
  diagnostics
- Messaging out: Telegram, Discord, Slack, LINE, log, macOS
  notification
- Voice: OpenAI Whisper + TTS, Piper TTS, Whisper.cpp STT
- Proactive notice loop with session lock (DND), per-tick retry,
  secret redaction
- REPL with end-of-session episode capture (SIGTERM-safe)
- Web search (SearXNG primary + DDG fallback) with time-range hint
- Trust / permission gates, injection guard, prompt-injection
  telemetry counter
- Encrypted export + collision-safe import; JWT secret rotation
  with grace window
- Status (--watch), Doctor (--watch), History (--grep + relative
  time + glyphs), Today (--brief + --save-to-notes)
- Observability: traces tail, metrics show, token-cost rollup,
  history rotation + gz compaction

## What batch 087-096 adds toward JARVIS

JARVIS does six things Muse can't do yet:

1. **See** — accept image input. (087 vision)
2. **Read** — accept document input. (088 PDF)
3. **Glance** — know what's on screen without being asked. (089)
4. **Recall across everything** — semantic search over notes +
   conversations + scheduled work. (090 episode index + 091 recall)
5. **Watch the world** — ingest external feeds. (092 RSS)
6. **Speak everywhere** — Linux desktop alerts, on-demand persona,
   anticipatory hints, terminal image render. (093 / 094 / 095 / 096)

## Sequencing notes

- **090 before 091**: recall depends on the episode index existing.
  If the loop hits 091 first, fall back to "notes-only" recall and
  mark the cross-source claim deferred.
- **087 + 096 are paired**: vision sees an image, show renders the
  same image in the terminal. Land 087 first so the dogfood for
  096 can chain (`muse show $img; muse vision $img`).
- **094 persona injection** touches `commands-ask.ts` and
  `commands-today.ts`. Both are stable; persona insertion is a
  prepend, not a refactor.
- **All 10 are additive** — no schema bumps, no breaking changes.

## Open-source-only constraint

Every dep introduced in this batch is MIT/Apache:

- 087 vision → Ollama HTTP (already in deps via OpenAI-compatible
  path); model `llama3.2-vision` or `llava` pulled at the user's
  machine.
- 088 PDF → `pdf-parse` (MIT, pure JS, ~40KB).
- 089 glance → `osascript` (macOS built-in).
- 090/091 → `node:crypto` cosine math (already used in notes RAG).
- 092 RSS → `fast-xml-parser` (MIT, pure JS, ~30KB).
- 093 libnotify → `notify-send` (system, every major Linux desktop).
- 094 persona → no new dep.
- 095 suggestions → no new dep.
- 096 show → ANSI escape codes (no dep).

## Dogfood discipline

Each goal's `## Verify` section contains a **Dogfood** block with
the exact shell commands to run after `pnpm check` + lint + smoke
gates pass. The agent runs them, captures stdout, asserts the pass
criterion, then commits. A failed dogfood reverts to "open" and
moves on — don't stack two goals on one commit.

For goals that need Ollama (087 + 090 + 091): the dogfood block
is best-effort. If Ollama isn't running on the test host, the
agent's job is to produce a clean "Ollama unreachable" stderr
hint and the goal still ships — the unit test carries the
correctness contract.

## Estimated time budget

| Goal | Build  | Test | Dogfood | Total |
|------|--------|------|---------|-------|
| 087  | 30 min | 10   | 5       | 45    |
| 088  | 30     | 10   | 5       | 45    |
| 089  | 20     | 5    | 5       | 30    |
| 090  | 40     | 15   | 5       | 60    |
| 091  | 40     | 15   | 5       | 60    |
| 092  | 50     | 15   | 10      | 75    |
| 093  | 20     | 5    | 5       | 30    |
| 094  | 30     | 10   | 5       | 45    |
| 095  | 20     | 5    | 5       | 30    |
| 096  | 20     | 5    | 5       | 30    |
| **sum** | | | | **450 min ≈ 7.5 h** |
