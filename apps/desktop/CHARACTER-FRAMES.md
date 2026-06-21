# Muse character frames (desktop)

The macOS companion is **frame-based**: drop PNG frames into
`apps/desktop/Sources/MuseDesktop/Resources/` and Muse animates real behaviours
(blink, wink, talk, emotions). Every frame except the neutral one is **optional**
and falls back to the neutral portrait — so behaviours light up as you add art.

## How to provide frames

- **Format:** PNG, **transparent background**, the **same canvas/size** as the
  hero (`muse-goddess.png`, the character centred identically in every frame so
  swapping is seamless — only the eyes/mouth/expression should change).
- **Where:** `apps/desktop/Sources/MuseDesktop/Resources/`
- **Rebuild:** `bash apps/desktop/scripts/make-app.sh` then `open apps/desktop/Muse.app`

## The frame set

| File | When Muse shows it |
| --- | --- |
| `muse-goddess.png` | **Neutral** — the base portrait. **(required, already present)** |
| `muse-goddess-blink.png` | Both eyes closed — a natural blink (~every 3s when idle). |
| `muse-goddess-wink.png` | One eye closed — a playful wink (~every 10s when idle). |
| `muse-goddess-talk.png` | Mouth open — alternated with neutral for lip-sync **while speaking**. |
| `muse-goddess-happy.png` | Smiling — shown **while listening** / greeting. |
| `muse-goddess-think.png` | Thinking expression — shown **while generating an answer**. |

You can add them in any order; each one that lands immediately starts being used.
On top of frames, Muse always adds a smooth float, gentle sway, breathing scale,
and twinkling sparkles, plus speech-bubble greetings.

## Generating them

These face frames are made with an image generator / artist (not code). Ask for
the **same character, same pose & framing, transparent background**, varying only
the named expression — e.g. "the same goddess, eyes closed" for `blink`, "mouth
open mid-speech" for `talk", "warm smile" for `happy`.

## Adding a new behaviour

To add another state/expression: add the PNG here, then map it in
`CharacterView.currentGoddessFrame()` (the switch over state) — `MuseAssets.frame("<name>")`.
