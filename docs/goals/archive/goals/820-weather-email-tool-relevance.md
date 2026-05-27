# 820 — fix: weather + email tools surface for natural/inflected prompts

## Why

819 fixed the home tools' natural-prompt exposure; the same
word-boundary keyword issue affects weather + email. The matcher uses
`\bkw\b`, so "any new **emails**?" (plural) doesn't match the `email`
keyword and "is it **raining**?" doesn't match `rain` — both
`email_recent` and `weather` were DROPPED for those natural phrasings,
the one-shot-selection failure the human flagged.

## Slice

- `@muse/mcp` weather-tool.ts — add inflected/natural + Korean keywords
  (raining/sunny/cloudy/snow/snowing/humid/windy/날씨/비/기온).
- email-tool.ts — `email_recent` + `read_email` gain `emails` / `mails`
  + Korean 이메일/메일.

## Verify

- `@muse/autoconfigure` perception-tool-relevance.test.ts (new, 5): the
  REAL `weather` + `email_recent` tools through the REAL
  `DefaultToolFilter` — "is it raining right now?" and "오늘 날씨 어때?"
  surface weather; "any new emails?" surfaces email_recent; an
  unrelated prompt ("capital of France?") surfaces NEITHER.
- **Mutation-proven**: removing the `emails` plural keyword → the
  plural-email case fails; restore → 5/5. Full `pnpm check` EXIT 0 (a
  pre-existing voice-playback TTS-cleanup timeout flaked once under
  load, passed on retry — unrelated), `pnpm lint` 0/0. Exposed catalog
  rides the model request → live SELECTION wants `smoke:live`; Ollama
  down → deferred.

## Decisions

- **Explicit inflected keywords, not a prefix matcher** — the
  word-boundary matcher is a deliberate design (avoids "dm" matching
  "admin"); per-tool inflected keywords (the 819 approach) are the
  sanctioned fix, so we don't risk "light"→"lightning" / "rain"→
  "rainbow" false positives.
- No bullet flip — tool-calling reliability (natural perception
  selection), completing the 819 sweep across weather + email.
  CAPABILITIES line under P20.
