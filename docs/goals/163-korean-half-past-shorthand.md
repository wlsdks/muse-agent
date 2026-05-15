# 163 — Korean `반` (half-past) shorthand

## Why

Completes the Korean relative-time line (160 day+time, 161
duration, 162 weekday). "3시 반" / "오후 3시 반" is the most
common way Koreans say :30 — more common than "3시 30분" in
speech. It was the last gap noted in goal 162.

## Scope

- `packages/mcp/src/loopback-relative-time.ts`:
  - `parseKoreanTimeOfDay` time regex tail
    `(?:\s*(\d{1,2})\s*분)?` →
    `(?:\s*(?:(\d{1,2})\s*분|(반)))?` — the minute is either
    `N분` (group 3) or `반` (group 4). `반` → minute 30.
  - Composes for free with every caller: day+time (160),
    weekday (162) — "다음 주 월요일 오후 6시 반" works because
    they all funnel through `parseKoreanTimeOfDay`.
  - Header doc updated.
- `packages/mcp/test/mcp.test.ts`:
  - "resolves the 반 (half-past) shorthand (goal 163)":
    오후 3시 반, 9시반 (no space, 24h), 오전 11시 반, weekday
    compose, plus a regression that explicit `N분` still wins.

## Verify

- `pnpm --filter @muse/mcp test` — 331 pass (1 new).
- `pnpm check` exit 0; `pnpm lint` exit 0.
- End-to-end (Ollama qwen3:8b API, reasoning off):
  `내일 오후 3시 반` → 2026-05-16 15:30, `오늘 9시반` →
  2026-05-15 09:30, `다음 주 월요일 오후 6시 반` →
  2026-05-18 18:30.

## Status

done — Korean relative-time parsing is now comprehensive
(day+time / duration / weekday / 반). Pure date logic, no
model round-trip (smoke:live not required).
