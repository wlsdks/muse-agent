# 030 — `muse doctor` overall health summary + exit code

## Why

`muse doctor --local` prints per-check rows but no overall
verdict. A script driver (`muse doctor --local --json` or a
shell wrapper) wants a single overall status + exit code for CI.

## Scope

- Compute `worst` over check statuses (already partially in
  `LocalDoctorReport.worst`).
- Footer line: `Overall: OK` / `Overall: WARN — N warning(s)` /
  `Overall: FAIL — N failure(s)`.
- Exit code: 0 on ok/warn, 1 on fail.
- `--json` already returns worst; document the exit-code mapping.

## Verify

- pnpm check / lint / smoke.
- cli +2 tests (warn → exit 0; fail → exit 1).

## Status

open
