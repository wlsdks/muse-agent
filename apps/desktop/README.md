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
- Click the character → **speak your question** (on-device; from the `.app`
  bundle) → she answers in the bubble and reads it aloud. In a bare `swift run`
  (no mic permission) a click opens a **text field** instead.
- **Pick the look** (menu-bar ♪ → Character, or `MUSE_DESKTOP_CHARACTER`):
  `orb` (default — a glowing, state-reactive voice orb, the modern AI-assistant
  visual), `muse` (a vector mascot), or the pixel sprites `aria` / `celestial`.
- **Summon from anywhere**: ⌃⌥Space (Control-Option-Space) shows/hides her.
- **Real app bundle** (needed for the mic permission): `./scripts/make-app.sh`
  then `open MuseDesktop.app`.

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
3. **(done)** A selectable avatar. The default is a glowing **voice orb**
   (`VoiceOrb`, Core Graphics — the Siri/Apple-Intelligence style, state-reactive
   pulse + ripples), chosen after researching how modern AI assistants present
   themselves. Alternates: a vector mascot (`muse`) and pixel sprites
   (`aria` / `celestial`). Switch via `MUSE_DESKTOP_CHARACTER` or the menu bar;
   preview headlessly with `--render-orb` / `--render-vector` / `--render-json`.
4. **(done)** Shell + packaging: a **menu-bar item** (♪ → Show/Hide, switch
   Character, Mute voice, Quit), a **global hotkey** (⌃⌥Space, Carbon — no
   Accessibility permission needed), and a real **`.app` bundle**
   (`scripts/make-app.sh` → `MuseDesktop.app` with a stable bundle id + the
   mic/speech usage strings, so voice can get permission).
5. **(done)** Voice input: click Muse → push-to-talk (speak your question) →
   on-device `SFSpeechRecognizer` (`requiresOnDeviceRecognition` — your voice
   never leaves the Mac; refuses rather than use the network) → she answers and
   reads it aloud. Needs the `.app` from step 4 for the mic permission; in a
   bare `swift run` she gracefully falls back to the text field.
