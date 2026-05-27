## 849 — feat: home_action is selectable for scenes & routines ("good night", "movie mode")

## Why

`home_action` calls ANY Home Assistant service, so scenes
(`scene.turn_on`) and scripts/routines (`script.turn_on`) were already
REACHABLE — but the tool couldn't be SELECTED for them: its keywords
were `home/light/lock/device` and its only example was
`light.turn_off`, so a natural "run my good night routine" / "activate
the bedtime scene" never surfaced the tool to the local model (the #1
one-shot-selection concern), and even when surfaced the description
didn't teach the `scene.turn_on` / `script.turn_on` shape. A whole
class of daily smart-home control was effectively unreachable.

## Slice — tool-calling reliability (exposure + description)

`@muse/mcp` smart-home-tool.ts — `home_action`:
- keywords gain `scene / scenes / script / routine / activate` so a
  scene/routine prompt surfaces the tool through the relevance filter;
- the description now teaches all three shapes by example: a device
  (`light.turn_off`), a scene ("movie mode" → `scene.turn_on` /
  `scene.movie_mode`), and a routine ("good night" → `script.turn_on` /
  `script.good_night`); the `service`/`entity` param examples likewise
  show scene/script ids — so when selected, the local model fills the
  right service in ONE shot (tool-calling.md).

## Verify

`@muse/autoconfigure` home-tool-relevance.test.ts (+1, 5 total), the
REAL `home_action` through the REAL `DefaultToolFilter`:
- "activate the bedtime scene" AND "run my good night routine" surface
  `home_action`; the existing device/lock/discovery prompts still
  surface the right home tools; an unrelated prompt still surfaces none
  (exposed set stays small).
- **Mutation-proven**: reverting to the original keyword set drops the
  scene/routine prompts (the new test fails). `@muse/mcp` 903/903,
  `pnpm check` EXIT 0 (0 non-voice failures), `pnpm lint` 0/0.
- The change is in the model-facing tool catalog (description +
  keywords). EXPOSURE is verified deterministically; the live one-shot
  SELECTION (does Qwen pick `home_action` + fill `scene.turn_on` for
  "good night"?) is `[UNVERIFIED-LIVE]` — Ollama is down this session,
  so the smoke:live round-trip is deferred.

## Decisions

- **Keywords for the explicit forms, examples for the args** — arbitrary
  scene NAMES ("movie mode") can't be keyword-matched, but "scene" /
  "routine" / "activate" catch the explicit asks, and the by-example
  description teaches the model the `scene.turn_on` / `script.turn_on`
  service shape so a selected call is correct. No new tool — one
  general actuator stays the single home-control entry (tool-calling.md
  rule 1). CAPABILITIES line under P18/tool-calling reliability.
