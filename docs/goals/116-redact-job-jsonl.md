# 116 — Redact credential shapes before persisting `~/.muse/jobs/<id>.jsonl`

## Why

`muse job run` runs a long-lived background prompt and persists
every event (`started` / `progress` / `result` / `error`) to a
per-job JSONL log. The on-disk log is durable across restarts +
read by `muse job status` / `muse job tail`. Same long-lived
persistence + replay surface goal 108 fixed for chat history.

A user kicking off `muse job run "draft a key-rotation memo for
sk-proj-…"` previously stored that secret indefinitely on disk in
`~/.muse/jobs/`, and `muse job status` (or any future read path)
would replay it.

## Scope

- New `apps/cli/src/job-event-scrub.ts`:
  - `scrubJobEvent(event)` — pure, shallow-clones the event with
    `prompt` + `text` fields routed through `redactSecretsInText`.
    Field allowlist is narrow on purpose: `model` / `userKey` /
    `type` / `tsIso` pass through so a value that *happens* to
    look credential-shaped (e.g. an internal id) isn't mangled.
  - Carved into its own module because `job-worker.ts` runs
    `main()` at top level — importing the worker into a test
    would spawn it.
- `apps/cli/src/job-worker.ts` `appendEvent` routes every event
  through `scrubJobEvent` before serialising. The `tsIso` stamp
  the helper adds is unchanged.

## Verify

- New `apps/cli/src/job-event-scrub.test.ts` covers:
  - `started.prompt` carrying `sk-proj-…` → redacted; structural
    fields (`model`, `userKey`, `type`) pass through.
  - `progress`/`result`/`error.text` carrying GitHub / AWS /
    Anthropic shapes → all redacted with the right marker name.
  - Clean text passes through unchanged.
  - Field allowlist gate: `model` / `userKey` that *match* a
    pattern are NOT redacted (allowlist-by-key narrow).
  - Input is not mutated.
- `pnpm --filter @muse/cli test` — 347 tests pass.
- `pnpm check` exit 0; `pnpm lint` exit 0.
- No real-LLM path touched.

## Status

done — `~/.muse/jobs/*.jsonl` joins the goal-108/109/111/112
credential-hygiene line. The background-job log surface is now
secret-clean on first write.
