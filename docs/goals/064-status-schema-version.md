# 064 — muse status JSON gains a schemaVersion field

## Why

Long-running scripts that pipe muse status --json into jq want a
stable schema marker so they can detect breaking changes.

## Scope

- Add 'schemaVersion: 1' to the top-level snapshot.
- Increment when fields are removed/renamed.

## Verify

- cli +1 test.

## Status

done — `muse status --json` now emits a top-level
`schemaVersion: 1` so jq pipelines can pin the contract
(`if .schemaVersion >= 2 then …`). The value lives in an
exported `MUSE_STATUS_SCHEMA_VERSION` constant so the test
suite + future bumpers have a single source of truth. Bump
when fields are renamed / removed — additive changes don't
bump. cli +1 unit test exercises the round-trip.
