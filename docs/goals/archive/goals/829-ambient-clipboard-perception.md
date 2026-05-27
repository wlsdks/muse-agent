## 829 — feat: ambient perception can react to the clipboard (opt-in)

## Why

P20 continuous perception: the macOS ambient source captured only the
frontmost app + window title, so ambient rules could react to WHERE the
user is but not to WHAT they just grabbed. The `AmbientSignal` already
had a `clipboard` field — nothing populated it. What you copy (a
tracking number, an address, a confirmation code, a URL) is a strong
intent signal; capturing it lets a proactive notice fire on it ("you
copied a tracking number — want me to track it?").

## Slice

`@muse/mcp` macos-ambient-source.ts — `MacOsActiveWindowSource` gained
opt-in clipboard capture:
- `includeClipboard` (default **false** — the clipboard is sensitive,
  so strictly opt-in), an injectable `readClipboard` (default spawns
  `pbpaste`), and `maxClipboardChars` (default 2000, so a huge paste
  can't flood the signal).
- `snapshot()` now reads the window AND (when enabled) the clipboard,
  attaches the trimmed/capped text as `signal.clipboard`. Clipboard
  rides the window signal; with NO frontmost app a clipboard-only
  signal still forms so a clipboard-keyed rule can fire. Fail-soft: a
  throwing/empty clipboard read never drops the window signal.
- `apps/api` tick-daemons.ts — the macOS ambient daemon passes
  `includeClipboard: MUSE_AMBIENT_CLIPBOARD` so a user opts in with one
  env var (`MUSE_AMBIENT_CLIPBOARD=true`).

## Verify

`@muse/mcp` macos-ambient-source.test.ts (+6, 12 total):
- does NOT read the clipboard unless opted in (privacy default — the
  injected reader is never called);
- with `includeClipboard`, attaches the trimmed + capped clipboard
  (maxClipboardChars=8 → "TRK-1234");
- clipboard alone forms a signal when there's no frontmost app;
- a throwing clipboard read is fail-soft (window signal still returns);
- an empty/whitespace clipboard adds nothing;
- **end-to-end**: a copied "…TRK-99…" drives a `clipboard:"TRK-"`-keyed
  ambient rule through the REAL `createAmbientNoticeRunner` → one
  proactive notice.
- **Mutation-proven**: removing the `includeClipboard` opt-in guard →
  the privacy-default test fails; dropping the `maxClipboardChars`
  slice → the trim+cap test fails. Full `pnpm check` EXIT 0, `pnpm
  lint` 0/0. Not a model-facing tool / no LLM path → no smoke:live.

## Decisions

- **Opt-in, off by default** — reading the clipboard every tick is
  privacy-sensitive; it ships dark behind `MUSE_AMBIENT_CLIPBOARD` and
  an explicit constructor flag, never on by default.
- **Cap + trim the captured text** — an ambient signal is matched as a
  substring and may be enriched/sent; an unbounded paste (a copied
  document) would bloat the signal and any notice, so it's clamped to
  2000 chars. CAPABILITIES line under P20 Perception (no bullet flip —
  deepens the existing continuous-perception capability).
