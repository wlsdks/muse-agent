# 372 — ICS TEXT unescaping mangled `\\n` (escaped backslash + n)

## Why

`apps/cli/src/ics-parser.ts` parses `.ics` calendar invites that
feed JARVIS-core ambient awareness — the morning brief and the
proactive daemon both list calendar events, and `muse calendar
import` / the watch-folder ingest run titles, locations and
descriptions through `unescapeIcsText`. The file had **no test
file at all** and a real RFC 5545 §3.3.11 correctness bug:

```ts
return value
  .replace(/\\n/gu, "\n")     // run FIRST
  .replace(/\\,/gu, ",")
  .replace(/\\;/gu, ";")
  .replace(/\\\\/gu, "\\");   // run LAST
```

Escapes were applied as independent sequential passes. For a raw
iCal value containing an **escaped backslash followed by `n`**
(`\\n` — which RFC 5545 defines as `\` then a literal `n`), the
first pass `/\\n/ → "\n"` matches the *second* backslash + `n` and
turns it into a newline, leaving a dangling backslash. Empirically
confirmed on the built module: raw bytes `A \ \ n B \ n C`
(`65,92,92,110,66,92,110,67`) must unescape to `A \ n B <LF> C`
(`65,92,110,66,10,67`) but produced `A \ <LF> B <LF> C`
(`65,92,10,66,10,67`) — the escaped backslash was destroyed and a
spurious newline injected. Any event note/location/summary carrying
a literal backslash sequence (Windows paths in meeting notes,
regexes, code snippets) was silently corrupted in the brief and
proactive notices.

## Scope

`apps/cli/src/ics-parser.ts`: `unescapeIcsText` rewritten as a
**single left-to-right pass** that consumes the backslash and the
escaped char atomically, so an escaped backslash can never have its
trailing char re-interpreted:

```ts
value.replace(/\\([\\;,nN])/gu, (_m, ch) =>
  ch === "n" || ch === "N" ? "\n" : ch);
```

(`\N` is also a newline per RFC 5545; the old code missed it too.)
Behaviour for the common cases (`\,` → `,`, `\;` → `;`, `\n` →
newline) is unchanged. The in-file `Goal 059 —` header marker was
stripped while editing (the recorded comment-policy method for a
file already under edit; see goals 369/370).

New `apps/cli/src/ics-parser.test.ts` — first direct coverage for
the untested `parseIcsEvents` export: timed event + DTEND default
(+30 min), `VALUE=DATE` all-day (UTC midnight, +1 day end), RFC
5545 line unfolding (space/tab continuation), malformed-block skip +
`startsAt` sort, empty / non-iCal body → `[]`, and the
escape-ordering regression asserted at the byte level
(`[65,92,110,66,10,67]`). Every expected value was empirically
verified against the rebuilt module before asserting.

## Verify

- `pnpm --filter @muse/cli test` — 653 pass (+6; new file, 56
  suites).
- `pnpm check` — every workspace green (apps/cli 653 incl. the
  `test/` glob, apps/api 165, all packages).
- `pnpm lint` — exit 0.
- goal-227/328 byte scan clean on both touched files (the test
  uses `String.fromCharCode(92)` + the TS `\n` escape, so no raw
  control/backslash bytes in source).
- No real-LLM request/response path touched — `parseIcsEvents` is a
  pure deterministic text parser; the calendar-import path does not
  go through the model. The deterministic suite with pre-write
  empirical byte verification is the rigorous verification.

## Status

done — ICS TEXT unescaping is RFC 5545-correct (single pass,
escaped backslash preserved, `\N` newline handled); the previously
untested calendar-invite parser now has direct coverage including
the byte-level escape regression, closing a silent
brief/proactive-notice corruption path.
