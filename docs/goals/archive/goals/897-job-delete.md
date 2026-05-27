# Goal 897 — `muse job delete <id>` removes a finished background-job record

## Outward change

`muse job delete <id-or-prefix>` removes a background job's record
file (`~/.muse/jobs/<id>.jsonl`). `muse job` could `run` / `status` /
`list` / `tail` jobs but had **no delete**, so every `muse job run`
left a `.jsonl` file that accumulated forever with no CLI way to
clean it — even though the sibling `muse runs` command has `delete`.
`job delete` resolves an exact id or unambiguous prefix (same UX as
`status`/`tail`), and **refuses a still-running job** unless `--force`
(deleting a running job's file orphans the worker's in-flight
output).

## Why this, now

A CRUD-completeness + cleanup gap, and an inconsistency with
`muse runs delete`. Background-job files are per-record (one per
`run`) and pile up; the user had to `rm ~/.muse/jobs/*.jsonl` by
hand. The delete verb is the missing terminal operation on the job
lifecycle. Distinct from the 895/896 append-log retention thread:
this is per-record file deletion (the missing CRUD verb), not
log trimming.

## How

Added `muse job delete <id>`: resolve via the existing
`resolveOrReportJobId` (exact / unique-prefix / ambiguous / none —
identical to `status`/`tail`), read the job's events to derive
status, refuse `running` without `--force`, then `unlink` the file.
`--json` emits `{ deleted, id, status }`. No new helpers — reuses
`jobPath`, `readJobLines`, `jobSummary`.

## Verification

`apps/cli` `commands-jobs.test.ts`: deletes a finished job by an
unambiguous prefix (asserts the `Deleted job <id> (done)` line AND
the `.jsonl` file is gone); a running job is refused without
`--force` (file still present) and removed with `--force`. Driven
through `registerJobCommands` + a temp `MUSE_JOBS_DIR`.
Mutation-proven: removing the running-job guard fails the
refuse-without-force test. The 2 full-suite failures are the known
voice-playback `/tmp` flake; `pnpm lint` 0/0. No LLM path → no
smoke:live (Ollama down regardless).

## Decisions

- Refuse a `running` job without `--force`: the detached worker is
  still appending to the file, so deleting mid-run orphans output
  (the next append silently recreates a partial file). `--force` is
  the escape hatch for a known-dead/zombie job.
- Did NOT add an age-based bulk clean — the per-id delete is the
  minimal complete CRUD verb; a bulk sweep can ride a later slice if
  job files actually pile up in practice.
