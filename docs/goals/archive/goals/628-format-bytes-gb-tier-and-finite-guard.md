# 628 — `human-formatters.formatBytes` promotes through a GB tier (in addition to B/KB/MB) and guards non-finite / negative inputs, so a 1.5GB notes file no longer renders as `1536.0MB` and a `NaN` size no longer renders as `NaNMB`

## Why

`apps/cli/src/human-formatters.ts:formatBytes` was the unit-
promotion ladder behind `formatNotesList`, `formatNoteSaved`,
and `formatNoteAppended` — every "(N MB)" line the personal-CLI
note commands write. Pre-fix:

```ts
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
```

Three missing cases:

1. **No GB tier.** A 1.5GB notes file (image-heavy markdown,
   imported PDF appendix, exported log dump) rendered as
   `1536.0MB`. Users seeing "1536MB" instead of "1.5GB" have
   to do the conversion in their head. The sibling
   `formatBytes` at `commands-doctor.ts:545` already promotes
   to GB; this was the missed sibling.
2. **No finite guard.** `formatNoteSaved({sizeBytes: NaN})`
   produced the literal stdout string `(NaNMB)`. The caller
   pre-filter is `typeof entry.sizeBytes === "number"`, which
   `NaN` and `Infinity` both pass. A stored size that arrived
   via `JSON.parse` of a corrupted file, or a buggy upstream
   that emitted `NaN` from a division, would print this
   gibberish.
3. **No negative guard.** `formatBytes(-5)` returned `"-5B"`.
   `fs.stat` can't produce a negative size on a healthy
   filesystem, but a stored size that drifted via a sign-bit
   flip or arithmetic mistake (subtraction underflow) would
   slip past the `typeof === "number"` filter.

The other two `formatBytes` implementations in the CLI tree
already do better — `commands-doctor.ts:545` has both the
finite-guard and the GB tier; `commands-setup-local.ts:146`
has the GB tier. This one was last to be updated.

Step-8 redirect: not tolerant-read normalisation (627), not
child-process stream error (626), not strict env-parse (625),
not HTTP timeout (624), not classification (623), not boolean
spelling (622). Defect class is **missing higher tier in
unit-promotion ladder + finite-guard** — fresh in the recent
window.

## Slice

- `apps/cli/src/human-formatters.ts`:
  - Add `if (!Number.isFinite(bytes) || bytes < 0) return
    "size unknown";` at the top — matches `commands-doctor.ts`
    convention.
  - Add the `< 1024 * 1024 * 1024` MB branch, falling through
    to the new GB branch (`(bytes / (1024 * 1024 * 1024))
    .toFixed(1)GB`).
  - Promote `formatBytes` from `function` to `export function`
    so the unit test can pin it directly. Internal-to-CLI
    surface; no cross-package API churn.
- `apps/cli/src/human-formatters.test.ts`:
  - Import the now-exported `formatBytes`.
  - Four new tests in a `describe("formatBytes — promotes
    through B/KB/MB/GB ...")` block:
    - **GB promotion** — `1.5 * 1024^3` → `"1.5GB"`,
      `1 * 1024^3` → `"1.0GB"`, `5 * 1024^3` → `"5.0GB"`
      (pins the GB tier exists and the boundary at 1024^3).
    - **B/KB/MB regression pin** — `0` → `"0B"`, `512` →
      `"512B"`, `1024` → `"1.0KB"`, `1024^2` → `"1.0MB"`,
      `500 * 1024^2` → `"500.0MB"` (pins that sub-GB tiers
      are unchanged — the fix is backward-compatible).
    - **Non-finite guard** — `NaN`, `+Infinity`, `-Infinity`
      → `"size unknown"` (pins the pre-fix `"NaNMB"` /
      `"InfinityMB"` symptom is gone).
    - **Negative guard** — `-1`, `-1024^2` → `"size unknown"`
      (pins the pre-fix `"-1B"` symptom is gone).

## Verify

- `@muse/cli` suite green (1079 passed, +4 vs the post-627
  baseline of 1075, 0 failed).
- **Clean-mutation-proven** (Edit-based): reverting BOTH the
  guard and the GB tier back to the 3-tier original makes
  EXACTLY THREE of the four new tests fail with the exact
  pre-fix symptoms — `Received: "1536.0MB"` for the GB test,
  `Received: "NaNMB"` for the non-finite test, `Received:
  "-1B"` for the negative test. The B/KB/MB regression-pin
  test still passes pre-fix because the sub-GB tiers are
  unchanged — confirms the fix is purely additive on the
  healthy path and only fixes the broken inputs. Fix restored,
  suite back to 1079/1079.
- `pnpm check` green: apps/api 261/261, apps/cli 1079/1079,
  every workspace.
- `pnpm lint` 0/0, `pnpm guard:core` clean, byte-scan clean on
  both touched files.
- No LLM request/response wire path touched; pure human-text
  formatter. `smoke:live` doesn't apply.

## Status

Done. The personal-CLI `(N <unit>)` output for notes is now
sane across all four realistic input shapes:

| `sizeBytes`                  | Before              | After                |
| ---------------------------- | ------------------- | -------------------- |
| `0`–`1023`                   | `${N}B`             | unchanged            |
| `1024`–`1024^2-1`            | `${N}KB`            | unchanged            |
| `1024^2`–`1024^3-1`          | `${N}MB`            | unchanged            |
| `1024^3`–`1024^4-1`          | **`1536.0MB` etc.** | `${N}GB` (**fixed**) |
| `NaN` / `+Infinity` / `-Infinity` | **`NaNMB` / `InfinityMB`** | `"size unknown"` (**fixed**) |
| Negative number              | **`-${N}B`**        | `"size unknown"` (**fixed**) |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a sibling-
parity / unit-formatting `fix:` matching the conventions
already used elsewhere in the CLI (`commands-doctor.ts:545`,
`commands-setup-local.ts:146`). Recorded honestly with this
backlog row — not a false metric.

## Decisions

- **Binary units (1024^3), not decimal (10^9).** macOS Finder
  / "Get Info", Windows Explorer, and `du -h` all show binary
  units. `commands-setup-local.ts:146` (the Ollama model-size
  formatter) uses binary too. `commands-doctor.ts:545` uses
  decimal — that one's reading network-quoted model sizes,
  where the upstream convention is decimal. Notes are local
  files; matching the OS file-manager UX wins.
- **`"size unknown"` (not `""` / `"?"`).** Matches the
  convention `commands-doctor.ts:545` already uses for non-
  finite. `""` would visually collapse the parenthesised
  size annotation, leaving `(file.md ())` — readable but ugly.
  `"?"` is terser but ambiguous with terminal control chars.
  `"size unknown"` is explicit and consistent.
- **Promote `formatBytes` to `export function`.** It was
  `function` (file-local). Three siblings in other files
  already had similar logic — testing each through its caller
  is doable but indirect, and the test would couple to the
  surrounding prose ("(N MB)"). Exporting is the minimum
  change that lets the test pin the formatter directly.
  Single-package internal surface; no cross-package API
  churn.
- **Did NOT also promote `commands-doctor.ts:formatBytes` and
  `commands-setup-local.ts:formatBytes` to share this one.**
  They use different unit conventions (decimal vs. binary)
  and different unknown sentinels. Unifying would change the
  user-visible output of `muse doctor` and `muse setup local`
  — out-of-scope for a robustness fix on the notes formatter.
  Each is internally consistent on its own surface.
- **Did NOT add a TB tier.** A multi-TB notes file is
  implausible (the user would hit ext4 / APFS limits long
  before they hit the formatter). A 5TB file would render
  as `5120.0GB` — readable, just not idiomatic. Adding TB is
  cheap but adds a new test branch without realistic ROI.
- **Mutation choice.** Reverted the WHOLE fix to the 3-tier
  pre-fix shape — both the guard AND the GB branch. Three
  tests fail; the regression-pin test stays green. Confirms
  the fix is additive on the healthy path and the test set
  pins exactly what changed.

## Remaining risks

- **Sibling formatters elsewhere in `apps/cli/src/`** still
  exist (`commands-doctor.ts:545`, `commands-setup-local.ts
  :146`). They're each internally consistent but inconsistent
  with each other on:
  - unit base (decimal vs. binary)
  - unknown sentinel (`"size unknown"` vs. `"?"`)
  - precision (`.toFixed(0)` for MB in doctor vs. `.toFixed
    (1)` in human-formatters)
  - tier ceiling
  Unifying these is its own iteration — the consumer-visible
  drift is small (Ollama models are big and round numbers;
  notes are small and non-round), so the cost of harmonising
  isn't obvious without a measured user request.
- **`.toFixed(1)` rounds**. `1023.5` bytes → 1023.5 / 1024 ≈
  0.999 → `.toFixed(1)` → `"1.0KB"`. Right at the boundary
  this looks like a stair-step jump (`1023B` then `1.0KB`).
  Cosmetic; the user can disambiguate with `--json`.
- **`-0`** passes `bytes < 0` as `false` (since `-0 === 0`),
  so `-0` would render as `"0B"`, not `"size unknown"`. JS
  signed-zero quirk; not user-visible in any realistic source.
- **No upper sanity-check** on `bytes`. A `Number.MAX_VALUE`
  input would render as some huge GB number with exponential
  notation in the `.toFixed(1)` output. Not realistic but
  also not asserted.
