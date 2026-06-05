# Muse Desktop — the macOS floating companion

A native macOS companion: an always-on-top, transparent, **draggable** pixel-art
Muse you click to talk to. It is a thin window over the **same local Muse
runtime** as the CLI — it shells out to `muse ask --local`, so cited recall, the
refusal floor, and the local-only privacy guarantee all hold end-to-end (there
is no second agent to keep in sync).

Native (Swift + AppKit `NSPanel`) was a deliberate choice (chosen by 진안) for
the best macOS integration — a non-activating floating panel, a Dock-less
accessory app, and a path to native mic / global hotkey / menu-bar presence.

## Run it

```bash
cd apps/desktop
swift run MuseDesktop          # the companion appears bottom-right; drag it anywhere
```

- The CLI is found as `muse` on your `PATH`. Override with `MUSE_BIN`
  (e.g. `MUSE_BIN="node /abs/path/to/apps/cli/dist/index.js" swift run MuseDesktop`).
- Click the character → a text field appears → ask about your notes → the cited
  answer shows in the speech bubble and is read aloud.
- **Pick a character**: `MUSE_DESKTOP_CHARACTER=aria` (default — a girl with
  headphones, enjoying the music) or `=celestial` (an ethereal starlit Muse).

## Verify

```bash
swift build                          # compiles the AppKit app + the bridge core
swift test                           # MuseDesktopCore logic, headless (18 tests)
swift run MuseDesktop --render out.png 24   # render the Muse sprite to a PNG (no window) — a faithful preview of the art
```

## Layout

- `Sources/MuseDesktopCore/` — the headless, unit-tested bridge to the `muse`
  CLI (`MuseBridge`: builds the local-first invocation, runs it, cleans output).
- `Sources/MuseDesktop/` — the AppKit app: `FloatingPanel` (the transparent,
  always-on-top, draggable window), `CharacterView` (the placeholder pixel
  mascot with idle/listening/thinking/speaking states), `main` (the accessory
  `NSApplication`).

## Slice plan

1. **(done)** Transparent, always-on-top, draggable panel + click → text input →
   local cited answer in a bubble.
2. **(done)** A pretty, human pixel-art **Muse** who speaks her answer aloud
   (on-device `AVSpeechSynthesizer`, local, citations dropped from the speech;
   `MUSE_DESKTOP_SPEAK=0` mutes). Faintly alive: breathes, blinks, mouths the
   words, shows a music note when listening/speaking.
3. **(done)** Genuinely pretty, **selectable** characters via a data-driven
   sprite system (`Sprite` + `SpriteLibrary`, designed by a multi-agent panel):
   `aria` (default — a girl with headphones enjoying music, the look you asked
   for) and `celestial` (an ethereal starlit Muse). Swap with
   `MUSE_DESKTOP_CHARACTER`; preview any candidate JSON with `--render-json`.
4. **Voice input**: click → push-to-talk (speak your question) — on-device
   speech.
5. **Shell**: a global hotkey + a menu-bar item; package as a real `.app` bundle.
