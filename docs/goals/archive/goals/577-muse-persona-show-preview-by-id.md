# 577 — `muse persona show --id <id>` previews any registered persona without switching active

## Why

Step-8 redirect onto CLI ergonomics — a feature gap on the
existing persona read surface. Today `muse persona show`
only shows the ACTIVE persona's preamble; previewing a
different persona requires `muse persona use <id> &&
muse persona show && muse persona use <prev-id>`.

That's destructive: the in-between active state switches the
user's memory bucket (each persona has its own
facts/preferences slot per goal-094), so even a one-second
preview can land a user-memory write into the wrong bucket
if the user types something during the preview. The
non-destructive equivalent — read the file, lookup the id,
print the preamble — is what `--id` should do.

Same convention class as goal-573's stdin-fallback on
`muse persona add`: an ergonomics improvement on the
existing persona surface. Different operation: 573 is the
write path, 577 is the read path.

## Slice

- `apps/cli/src/commands-persona.ts` — added `--id <id>`
  option to `muse persona show`. When provided, the action:
  - Trims and validates the id against built-ins + custom
    keys via the existing `personaIdIsKnown` helper.
  - On unknown id, surfaces the same `closestCommandName`-
    based did-you-mean hint pattern goals 100/543/575 use,
    exiting 1.
  - Otherwise resolves the preamble using the SAME
    precedence as the active resolver (`custom override
    wins over built-in`) and prints it under a
    `preview: <id> (active is <activeId>)` banner.
  - The JSON envelope adds a `previewingId: <id>` key when
    `--id` is set; absent otherwise (envelope stays
    backwards-compatible for callers that grep on
    `activeId` only).
  - When `--id` is omitted, the action falls back to the
    existing active-show behaviour byte-for-byte.
- `apps/cli/test/program.test.ts` — added one `it(...)`
  covering: preview built-in (`jarvis`) doesn't mutate
  active; preview custom (`tony`) prints the registered
  preamble; `--json` envelope carries `previewingId`;
  typo'd `--id` surfaces did-you-mean + exits 1; bare
  `muse persona show` keeps the legacy banner.

## Verify

- New `it(...)` green; full `@muse/cli` suite green (1030
  passed, +1 vs baseline 1029, 0 failed); tsc strict
  EXIT=0.
- **Clean-mutation-proven** (Edit-based): collapsing the
  `--id` handling branch back to the bare
  `targetId = store.activeId; preamble =
  resolveActivePersonaPreamble(store);` legacy shape
  makes the preview test fail with `expected ... to
  contain "preview: jarvis (active is default)"` — the
  banner disappears and the preview is silently replaced
  with the active output. Fix restored, suite back to
  all green.
- `pnpm check` EXIT=0, every workspace green (apps/api 249
  passed, apps/cli 1030 passed); `pnpm lint` 0/0; `pnpm
  guard:core` clean; byte-scan clean; `git status` shows
  only the three intended files.
- Pure CLI input → output formatter — no LLM
  request-response wire path; `smoke:live` does not apply
  (per `testing.md` / iteration-loop Step 9). The
  defended path is `muse persona show --id <id>` user
  output, not the model loop.

## Status

Done. The persona read surface is now complete:

| Command | Reads |
| --- | --- |
| `muse persona list` | All known personas + active id |
| `muse persona show` | Active persona's preamble |
| `muse persona show --id <id>` | **Any registered persona — preview without activating** (this goal) |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a
CLI ergonomics feature on the existing persona read
surface, recorded honestly with this backlog row — not a
false metric.

## Decisions

- The `--id` flag does NOT mutate the store. Preview is
  purely a read operation; the active persona stays
  unchanged. The negative assertion
  (`afterPreview.activeId === "default"`) pins this.
- Banner format: `preview: <id> (active is <activeId>)`
  for clarity. The user-visible distinction between
  preview and active is load-bearing — without it a
  novice might think `--id` switched active and never
  switch back.
- `--json` envelope adds `previewingId: <id>` only when
  `--id` is set. The existing `{ activeId, preamble }`
  shape stays intact for callers that don't use
  `--id`. Backwards-compatible additive change.
- Resolution precedence mirrors the active resolver:
  custom override wins over built-in. Reason: the user's
  custom entries can override a built-in (goal 094); the
  preview should reflect the same precedence the active
  resolver uses, so a preview of `jarvis` matches what
  `muse persona use jarvis` would actually activate.
- Did NOT extract a shared `resolvePersonaPreambleFor
  (store, id)` helper. Reason: one-iteration-per-area
  scope; the inline ternary is 4 lines vs. a separate
  helper + import. A future iteration that adds more
  callers can lift it.
- The typo path on `--id` uses the same closest-command
  shape goals 545/575 use. Cross-command typo-tolerance
  convention is uniform.
- Variadic `--id` not supported (single id only). The
  preview semantics for "show me three previews at
  once" would be unclear (output ordering, banner
  separation); `muse persona list` already shows every
  registered id with descriptions. The single-preview
  shape is the right grain.
- Step-8 sub-defect-class check: CLI ergonomics (feature
  gap on read surface) is distinct from the recent
  comparator-determinism (574), did-you-mean (575),
  error-UX (576). The goal-573 stdin ergonomics was a
  WRITE-surface gap on the SAME command family; this is
  the read-surface complement. Fresh defect-class slot.
