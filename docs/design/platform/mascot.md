# Muse's bluebird — the mascot

> **Muse** is the product. The **bluebird** is its companion mascot — a small
> pixel bird that lives inside Muse the way the Octocat lives in GitHub, Ferris
> in Rust, or the old Larry bird in Twitter. The mascot doesn't have to share the
> name; it has to share the *feeling*.

This is the canonical reference for the bluebird — its story, its personality,
its full behaviour catalogue, its palette, and the single-source architecture
that keeps it from ever drifting in pixels or in meaning. If you touch the
mascot, read this first; if you change its pixels, update this alongside.

See the living preview: [`mascot-showroom.html`](./mascot-showroom.html).

---

## The concept

The bluebird is the **good-news bird** — the fairy-tale *파랑새* that brings you
what it found. It sits quietly at the edge of your screen, watches without
getting in the way, and **chirps when — and only when — it actually has
something for you**. That is the whole character in one line, and it maps
directly onto what Muse is:

- **It brings you what it found, not the world's.** The bird carries back *your*
  note, *your* fact, *your* upcoming thing — grounded and cited. It never
  invents a worm it didn't catch (Muse drops an un-groundable claim in code).
- **It watches quietly.** A companion, not a co-pilot barking at you. Most of the
  time it just… stands there and blinks. Proactivity is earned: a chirp means a
  real, source-backed notice, never noise.
- **It's small, local, and yours.** A little bird that lives on *your* machine.
  It doesn't fly off to a server.

We deliberately keep this honest. The bird is charming, not magical — it doesn't
promise the moon, it promises to hand you the one thing it's sure about.

---

## Personality

- **Calm by default.** Its resting state is genuinely restful — a slow blink, an
  occasional head-tilt or a little preen. It is not an attention-seeking
  animation loop.
- **Attentive when you need it.** When Muse is working, the bird stops fidgeting,
  stands tall, and *listens* — a visible "I'm on it."
- **Quietly delighted to deliver.** When an answer lands, it does one small happy
  hop and a single chirp. The joy is proportionate: a hop, not fireworks.
- **Never pushy, never fake-cheerful.** No permanent grin, no confetti on every
  turn. Warmth is reserved so it stays meaningful.

---

## Behaviour catalogue — and what each means to you

Every pose is a `FrameName` in [`packages/mascot/src/pixel-data.ts`](../../../packages/mascot/src/pixel-data.ts).
Grouped by what the user should read from it:

### Resting — "I'm here, nothing to report"

| Pose(s) | Reads as |
| --- | --- |
| `stand` | The baseline. Standing, open-eyed, watching. |
| `blink` | A natural blink (~every 3s). Just alive. |
| `tilt` | A curious head-tilt — idle curiosity, no demand on you. |
| `preen`, `peck`, `tail`, `stretch`, `ruffleA`/`ruffleB` | Small idle micro-behaviours (grooming, a fidget). They give the bird life during long quiet stretches without ever signalling activity you must react to. |

### Low energy — "quiet, nothing's happening"

| Pose(s) | Reads as |
| --- | --- |
| `doze` (+ the sleepy `ZZZ` accent) | Eyes shut, drowsing — a long idle period, low system activity. |
| `droop` | Subdued / winding down. |
| `sing` (+ the muted `NOTE` accent) | A soft, self-amused little song — light idle flavour, a nod to Muse's name. Deliberately in a *muted* colour, not the bright chirp indigo, so it never reads as "I have news." |

### Attending — "I'm working on this"

| Pose(s) | Reads as |
| --- | --- |
| `attend` | Stops still, eyes wide, head forward — Muse is thinking / listening to you. The clearest "I'm on it." |
| `flapA`/`flapB`, `hopUp`/`hopLand` | Motion frames: a wing-flap, or the up→land hop used to compose animated sequences. |

### Delivering — "I have something for you" (the earned moment)

| Accent | Reads as |
| --- | --- |
| `CHIRP` (bright indigo `#828fff`, pops above the head) | A response arrived / a grounded proactive notice is ready. This is the **only** bright, upward accent — it is reserved for a real, source-backed delivery so a chirp always means something. |
| `HEART` (`#f2789f`) | A reserved warm pop for a genuine celebrate() moment — used sparingly. |

The design rule that ties this together: **bright + upward = news; muted = just
life.** The sleepy `z` and the idle song notes are intentionally *not* the chirp
colour, so the user is never trained to ignore a chirp.

---

## Palette

The whole bird is a nine-colour ramp — the app's periwinkle/indigo, a warm
white belly, and two small warm accents (blush + beak) that give it a face.

| Char | Hex | Role |
| --- | --- | --- |
| `B` | `#8b9dff` | Body — bright periwinkle-blue (pops on the near-black canvas) |
| `S` / `T` | `#6b78e8` | Wing / back / tail — one step darker, same hue |
| `W` | `#f4f1ea` | Belly / breast — warm white |
| `K` | `#1b1e2e` | Eye — soft near-black (a single forward pixel) |
| `C` | `#e79ab0` | Blush cheek — soft muted pink |
| `A` | `#f2c14e` | Beak — warm yellow |
| `L` | `#b7a98f` | Legs — warm grey stubs |
| `CHIRP` | `#828fff` | Response-arrived chirp accent (bright indigo) |
| `MUTED_ACCENT` | `#8a8f98` | Sleepy `z` / idle song notes (deliberately dim) |
| `HEART` | `#f2789f` | Reserved celebrate() heart |

Grid: **13 × 11**, authored facing **right**; the left facing is a render-time
mirror. Transparent (`.`) draws as nothing, so the bird floats on any surface.

---

## Single-source architecture (and the drift guard)

`packages/mascot` (`@muse/mascot`) is the **one source of truth** for every
matrix and every colour. Nothing else hand-draws the bird — every surface
renders from this package:

```
packages/mascot/src/
  pixel-data.ts   ← the FRAMES matrices + PALETTE  (edit HERE, nowhere else)
  to-ansi.ts      → terminal truecolor half-blocks  (CLI)
  to-svg.ts       → self-contained animated SVG      (README)
```

Consumers, all fed from that single source:

| Surface | How it renders | Entry point |
| --- | --- | --- |
| **CLI** banner / `muse logo` | ANSI half-blocks (`toAnsi`) | [`apps/cli/src/muse-mascot.ts`](../../../apps/cli/src/muse-mascot.ts) |
| **README** hero | animated SVG (`toSvg`, CSS keyframes) | [`docs/assets/mascot.svg`](../../assets/mascot.svg) (generated) |
| **Web** DeskPet | live pixel render | `apps/web/src/components/pixel-bird.ts` |
| **macOS app** icon + companion + Settings/Onboarding header | rasterised PNG / `.icns` | [`apps/desktop/scripts/gen-app-icon.mjs`](../../../apps/desktop/scripts/gen-app-icon.mjs) |

**The drift guard.** `apps/web` is deliberately outside the TypeScript
project-reference graph (a Vite island with no `@muse/*` deps), so it keeps a
local mirror in `pixel-bird.ts`. A test — `apps/web/src/components/mascot-drift.test.ts` —
reads `@muse/mascot`'s source as text and **fails if the mirror ever diverges**.
So there is exactly one place to change the bird, and CI proves nobody forked it.

---

## Where the bird appears

- **Terminal** — the `muse` banner and `muse logo` (with a one-shot blink), beside
  the block wordmark.
- **README** — the animated SVG hero at the top of the repo.
- **Web DeskPet** — a live pixel bird that idles, attends, and chirps over the
  chat composer (see the [showroom](./mascot-showroom.html)).
- **macOS app** — the Dock / Finder / ⌘-Tab **app icon** (a Big Sur squircle
  plate), the floating **companion** avatar, and the Settings / Onboarding
  headers.

---

## Regenerating assets

All generated from `@muse/mascot` — never hand-edit the outputs.

```bash
# 1) Build the source of truth
pnpm --filter @muse/mascot build

# 2) README animated SVG  → docs/assets/mascot.svg
pnpm --filter @muse/mascot gen:svg

# 3) macOS app icon (.icns)  — variant: flat | gradient | glow (default: gradient)
MUSE_ICON_VARIANT=gradient  apps/desktop/scripts/make-icon.sh

# 4) macOS companion / header PNG  → apps/desktop/Sources/MuseDesktop/Resources/muse-bird.png
node apps/desktop/scripts/gen-app-icon.mjs --bird \
  --out apps/desktop/Sources/MuseDesktop/Resources/muse-bird.png
```

The app-icon generator (`gen-app-icon.mjs`) renders the bird at a moderate
**integer** pixel scale (crisp, nearest-neighbour — no blur) centred on a macOS
"Big Sur" superellipse plate with the standard safe-area margin. `--previews`
writes all three background variants side by side so a human can pick.
