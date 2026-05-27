# 503 — `apps/api` listen config strict-parses PORT + treats empty HOST as unset (server startup safety)

## Why

`apps/api/src/index.ts` is the API server entry point. Pre-fix
it computed:

```ts
const port = Number(process.env.PORT ?? 3030);
const host = process.env.HOST ?? "127.0.0.1";
```

Two real defects on the server startup wire path:

- **`PORT=""`** (the pre-cleared-env launcher pattern):
  `"" ?? 3030` → `""` → `Number("")` → `0`. Fastify binds an
  **ephemeral port** the operator can't reach — the server
  starts, the operator's `curl http://localhost:3030`
  doesn't, and there's no error to point at.
- **`PORT="3030x"`** typo / unit-slip: `Number("3030x")` →
  `NaN`, which Fastify rejects with an opaque error.
- **`HOST=""`**: `?? ` keeps the empty string. Fastify treats
  empty as `::` on dual-stack platforms — silently binding
  to **all interfaces** when the operator set `HOST=`
  expecting "default loopback". Real security/expectation
  failure: a developer's local-only API gets exposed on the
  LAN.

Both are the empty-env-shadow defect class (478/481/482/483/
488/495) plus the lenient-`Number()`-on-typo class
(414/444/463/469/470/489/502) on **the most safety-critical
boundary of the API** — where the server decides what to
listen on.

## Slice

- `apps/api/src/listen-config.ts` — new side-effect-free
  module with two pure helpers:
  - `resolveListenPort(raw, fallback=3030)` — strict parse
    via `/^\d+$/` + `Number.isInteger && > 0 && ≤ 65535`;
    fallback on undefined / empty / whitespace / typo /
    unit-slip / negative / float / out-of-range / signed.
  - `resolveListenHost(raw, fallback="127.0.0.1")` — trim +
    length-check; fallback on undefined / empty /
    whitespace-only.
- `apps/api/src/index.ts` — imports + calls the helpers
  instead of the inline `Number(... ?? 3030)` / `?? "127.0.0.1"`
  expressions.
- `apps/api/test/listen-config.test.ts` — new file, 8
  focused tests covering both helpers: fallback / clean /
  12+ typo/unit-slip/signed/float/empty cases / custom
  fallback / non-empty trim / empty-shadow.

## Verify

- New test 8/8 green; full `@muse/api` suite green (224
  passed, +8, 0 failed); tsc strict (api) EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting
  `resolveListenPort` to the prior lenient
  `Number(raw ?? fallback)` + `isFinite` form makes the
  empty-string test fail with the precise pre-fix symptom
  (`"" must fall through: expected 0 to be 3030` — the
  ephemeral-port bind the operator can't reach) while every
  other test stays green; fix restored, suite back to 8
  green.
- `pnpm check` EXIT=0, every workspace green — no regression
  (the entry-point's behaviour is byte-identical for every
  clean PORT/HOST value); `pnpm lint` 0/0; `pnpm guard:core`
  clean (no IMMUTABLE-CORE touched); byte-scan clean;
  `git status` shows only the three intended files.
- Pure config resolution — no LLM / model request-response
  wire path; `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9).

## Status

Done. The API server no longer silently binds ephemeral on
`PORT=""` and no longer surprises an operator by exposing the
server on all interfaces when `HOST=""`. The two empty-env-
shadow + lenient-parse defect classes now cover the server
startup boundary — the most consequential instance of either
class in the codebase, since a wrong bind state silently
breaks the entire API.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a safety-relevant `fix:` on
the API entry point, recorded honestly with this backlog row
— not a false metric.

## Decisions

- Extracted to a new side-effect-free module
  (`listen-config.ts`) rather than testing through `index.ts`:
  the entry-point runs `server.listen()` at import time, so
  a direct test would start a real server. The new module
  carries the parse contract that the entry-point now calls.
- Capped `PORT` at the legal IP port range (1-65535) so a
  `PORT=99999` typo can't reach `listen()` and produce a
  cryptic Fastify error. The cap is informed by RFC 6335 §6;
  the bottom 0 and -1 also fall through.
- Did NOT cap `HOST` to any specific format (IP / DNS):
  Fastify accepts a wide range and operators legitimately
  pass IPv6 / DNS / unix-socket-prefix forms. The only
  contract we pin is "non-empty trimmed string".
- Distinct from the recent surrogate-cap run (499/500/501)
  and from the 502 strict-parse iteration — same class as 502
  but on a different consumer with two helpers in one
  coherent module.
