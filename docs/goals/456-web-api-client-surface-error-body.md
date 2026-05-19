# 456 — Web api-client surfaces the server's error message, not a bare status (449 UI-consumer sibling)

## Why

`createApiClient` (`apps/web` `ui/api-client.ts`) is the fetch
wrapper **every web console panel** uses. On a non-2xx response
it did:

```ts
throw new Error(`${response.status} ${response.statusText}`);
```

It **discarded the server's structured error body**. The API
returns `{ errorCode, errorMessage, message, … }` on failure —
and goal 449 specifically added `503 UPSTREAM_UNAVAILABLE` with
an actionable `errorMessage` ("upstream unavailable, retry") so a
client could tell a transient failure from a permanent one. The
web console — a primary JARVIS surface — threw that away and
showed the user a bare `"503 Service Unavailable"`. Worse, under
HTTP/2 `fetch` returns an **empty** `statusText`, so the user
saw `"503 "` — a near-useless error with the actionable detail
the server went to the trouble of producing (449) silently
dropped at the final consumer.

This is the error-UX completion of the 449 `.retryable` /
error-message chain at the UI edge (the 415/432/443/449
advertised-but-discarded-contract family). A grep confirmed
there was **no** direct `api-client` test — the error path was
genuinely uncovered. Fresh package (web last touched goal 375,
~80 iterations ago); an error-UX `fix:`, a different kind than
the recent run.

## Slice

- `apps/web/src/ui/api-client.ts` — the `!response.ok` branch now
  throws via an `errorDetail(response)` helper: builds `status`
  (`"503 Service Unavailable"`, or just `"503"` when statusText
  is empty — fixes the HTTP/2 trailing-space cosmetic too), then
  defensively reads the JSON body and appends the first non-empty
  `errorMessage` / `message` string (`"503 …: <server message>"`).
  Non-JSON / empty / proxy-HTML body → `catch` → bare status
  (behaviour-identical for bodiless errors — no regression). The
  success and 204 paths are untouched.
- `apps/web/src/ui/api-client.test.ts` — new co-located unit test
  (stubbed `globalThis.fetch`, restored in `afterEach`): a 503
  with `errorMessage` → thrown message includes the server text;
  empty-statusText + `message` fallback → `"503: boom"` (no
  double space); a non-JSON error body → falls back to
  `"500 Internal Server Error"`; success returns the parsed body
  and 204 returns `undefined` (no-regression anchors).

## Verify

- New tests green; full `@muse/web` suite 27 passed (3 files,
  +1 file / +4 it); tsc strict (web) EXIT=0.
- **Mutation-proven teeth**: neutralising the `errorDetail` call
  makes the new test fail with exactly `expected … to throw
  error including '503 Service Unavailable: the local model…'
  but got 'x'`; `await errorDetail(response)` occurrence count
  went 1→0 then restored to 1, suite back to 27 green.
- `pnpm check` EXIT=0, every workspace green (web 27, cli 739,
  …) — no regression; `pnpm lint` 0/0; `pnpm guard:core` clean;
  byte-scan clean; `git status` shows only the two intended
  files.
- Pure frontend fetch-wrapper logic (faked `fetch` in the test)
  — not a model request/response wire path (449 was the
  server-side wire edit; this is the browser client surfacing
  what the server already returns); `smoke:live` does not apply
  (per `testing.md` / iteration-loop Step 9).

## Status

Done. The web console now shows the server's actionable error
("upstream unavailable, retry", a guard-block reason, a
validation hint) instead of a bare — and under HTTP/2,
nearly-empty — status code. The 449 error contract is now
honoured end-to-end: server emits the message, HTTP boundary
preserves the status, the browser client displays it.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; an error-UX `fix:` to an existing
surface (449 UI-consumer sibling), recorded honestly with this
backlog row — not a false metric.

## Decisions

- Read only `errorMessage` / `message` (the server's documented
  error shape), not arbitrary body text: surfacing a raw proxy
  HTML blob would be worse UX than the bare status; the bare
  status is the correct, safe fallback for any non-conforming
  body.
- Co-located `api-client.test.ts` with a minimal hand-rolled
  fetch stub (only `.ok/.status/.statusText/.json` are used):
  the existing web tests are RTL component tests with fake
  clients; a direct unit test of the exported client's error
  contract is the right, non-redundant coverage (the 407/434
  no-implicit-only-coverage discipline).
