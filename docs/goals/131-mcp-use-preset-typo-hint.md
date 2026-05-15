# 131 — `muse mcp use <typo-preset>` suggests the closest valid preset

## Why

`muse mcp use filsystem` (typo for `filesystem`) printed
`Unknown preset 'filsystem'. Available: filesystem, fetch, time,
sqlite, memory`. The list is useful but the user still has to
spot the typo themselves. JARVIS-class CLIs hand them the
closest match.

This extends the typo-suggestion line goals 099 / 100 / 118 /
119 / 124 / 125 run elsewhere into the MCP preset surface.

## Scope

- `apps/cli/src/commands-mcp.ts` `mcp use` action:
  - On unknown preset, run the offending value through
    `closestCommandName` against `Object.keys(MCP_PRESETS)`.
  - When a match falls inside the length-aware Levenshtein cap,
    append `— did you mean 'X'?` to the error message.
  - Otherwise leave the existing "Available: …" guidance
    untouched — no false-positive suggestion.

## Verify

- New `apps/cli/test/program.test.ts` case pins:
  - `mcp use filsystem` → "did you mean 'filesystem'?".
  - `mcp use totally-unknown-preset` → "Unknown preset 'totally-…'"
    + "Available: …", NO "did you mean" line.
- `pnpm --filter @muse/cli test` — 352 tests pass.
- `pnpm check` exit 0; `pnpm lint` exit 0.
- No real-LLM path touched.

## Status

done — MCP preset selection now joins the rest of the
typo-suggestion line.
