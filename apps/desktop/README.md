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
  answer shows in the speech bubble.

## Verify

```bash
swift build                    # compiles the AppKit app + the bridge core
swift test                     # MuseDesktopCore bridge logic (headless)
```

## Layout

- `Sources/MuseDesktopCore/` — the headless, unit-tested bridge to the `muse`
  CLI (`MuseBridge`: builds the local-first invocation, runs it, cleans output).
- `Sources/MuseDesktop/` — the AppKit app: `FloatingPanel` (the transparent,
  always-on-top, draggable window), `CharacterView` (the placeholder pixel
  mascot with idle/listening/thinking/speaking states), `main` (the accessory
  `NSApplication`).

## Slice plan

1. **(done)** Transparent, always-on-top, draggable panel + placeholder pixel
   character + click → text input → local cited answer in a bubble.
2. **Voice**: click → push-to-talk through the existing local `@muse/voice`
   (whisper.cpp STT + Piper TTS) so you can speak and hear the answer.
3. **Character**: a real pixel-art sprite sheet animated by the agent state;
   a global hotkey + menu-bar presence.
4. Packaging: a signed/notarised `.app` (personal use runs unsigned).
