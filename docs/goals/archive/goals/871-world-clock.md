## 871 — feat: `muse time [place]` — world clock across timezones

## Why

A JARVIS should answer "what time is it in Tokyo?" / "is it a
reasonable hour to call London?" reliably. The model alone guesses
timezones and gets DST wrong; Muse had no deterministic clock. Real
daily need for anyone with international contacts, travel, or calls —
and it composes with the people graph (a contact's locale).
Zero-dependency via the platform `Intl` zone database.

## Slice

`apps/cli` timezone.ts:
- `resolveTimezone(input)` — a known spoken alias (tokyo / 'new york' /
  LA / utc, case-insensitive) or a raw IANA zone the platform
  recognises (`Asia/Tokyo`); undefined for anything else (no guess).
- `formatTimeInZone(zone, at)` — weekday + 24h clock in that zone via
  `Intl.DateTimeFormat`, machine-timezone-independent and DST-correct.
- `muse time [place]` — current time in the place (or the local zone
  when omitted); unknown place → a clear error + exit 1. `--json` for a
  payload.

## Verify

`apps/cli` timezone.test.ts: `resolveTimezone` maps aliases + raw IANA
zones, returns undefined for unknown / empty; `formatTimeInZone` renders
the correct wall-clock (UTC-midnight → Tokyo 09:00) and is DST-correct
(London 01:00 in July BST, 00:00 in January).
- **Mutation-proven**: making the IANA validator always-true fails the
  "unknown returns undefined" test.
- `pnpm check` EXIT 0, `pnpm lint` 0/0. Pure `Intl`, no network / no
  LLM path.

## Decisions

- **Deterministic, not model-guessed** — the value over "ask the LLM" is
  DST-correctness and a real clock; an unknown place is reported, never
  approximated.
- A small curated alias table for the cities people actually say, plus
  raw IANA passthrough (validated by `Intl`) so any of the ~600 zones
  works without maintaining a full city map.
- CLI-only this slice (an agent `world_time` tool can follow once Ollama
  is up to verify selection). No new dependency.
