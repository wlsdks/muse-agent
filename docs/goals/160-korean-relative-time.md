# 160 — Korean relative-time phrases

## Why

Dog-food finding: `muse tasks add --due "내일 오후 3시"` was
rejected. The user is Korean and types times in Korean; a
JARVIS-style personal assistant must parse the user's native
phrasing as readily as English. Goal 159 fixed the English
no-`at` form; this adds the Korean equivalent.

## Scope

- `packages/mcp/src/loopback-relative-time.ts`:
  - `resolveKoreanRelativePhrase` tried first (Korean phrases
    never collide with the English lowercase patterns).
  - Day words: 오늘 / 내일 / 모레 / 글피 (0–3 day offset).
  - `parseKoreanTimeOfDay`: 오전/오후 N시 (M분)?, bare 24h
    `N시`, 정오 → 12:00, 자정 → 00:00. 오후 12시 → noon,
    오전 12시 → midnight (mirrors the English am/pm edge).
  - Bare day → 09:00 default, identical to the English path.
- `packages/mcp/test/mcp.test.ts`:
  - "resolves Korean day + time phrases (goal 160)" — the six
    canonical forms + the 12시 meridiem edges.
  - Reject cases extended: 어제 (unsupported day), 오후 13시,
    25시 (out-of-range hour).

## Verify

- `pnpm --filter @muse/mcp test` — 328 pass (1 new).
- `pnpm check` exit 0; `pnpm lint` exit 0.
- End-to-end (Ollama qwen3:8b API, reasoning off):
  `--due "내일 오후 3시"` → due 2026-05-16 15:00 (previously
  rejected). 오늘 오전 9시 30분 / 모레 정오 / 내일 자정 /
  오늘 15시 / bare 내일 all resolve correctly.

## Status

done — pure date logic, no model round-trip changed
(smoke:live not required). Out of scope (later goals):
relative day-offsets in Korean ("3일 후"), weekday names
("다음 주 월요일"), "반" (half-hour) shorthand.
