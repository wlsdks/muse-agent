# @muse/mascot

Single source of truth for the Muse bluebird mascot's pixel data, plus renderers to ANSI
truecolor half-blocks (terminal) and animated SVG (README). `apps/web` keeps a local mirror
because it sits outside the TypeScript project-reference graph; a drift-guard test reads this
package's source as text and fails if the two diverge.

## Public surface

- `.` (`src/index.ts`, re-exporting `pixel-data.js`, `to-ansi.js`, `to-svg.js`) — the pixel
  matrices and palette (`FRAMES`, `PALETTE`, `GRID_W`/`GRID_H`, `FrameName`, `CHIRP_FRAME`,
  `HEART_FRAME`, `ZZZ_FRAME`, `NOTE_FRAME`, `validateFrame`), `toAnsi` (renders a frame to
  terminal half-block glyphs), and `toSvg`/`DEFAULT_SEQUENCE` (renders a CSS-animated,
  camo-safe SVG for the GitHub README).

## Depends on

No internal `@muse/*` dependencies — pure data and rendering, no DOM.

## Rules that bind this package

- This is the canonical pixel-data source; `apps/web`'s mirror must be updated in lockstep or its
  `mascot-drift.test.ts` fails.
- `docs/assets/mascot.svg` is generated output (`pnpm --filter @muse/mascot gen:svg`, backed by
  `scripts/gen-mascot-svg.ts`) — never hand-edit the SVG.

## Tests

`pnpm --filter @muse/mascot test`
