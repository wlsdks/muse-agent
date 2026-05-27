# 599 — `LocalCalendarProvider` persists `~/.muse/calendar.json` with mode 0o600 + post-rename chmod (closes the intra-package asymmetry with the calendar credential-store)

## Why

`packages/calendar/src/local-provider.ts:writeAll` wrote
the local calendar file with the OS default umask:

```ts
await fs.writeFile(tmp, payload, "utf8");
await fs.rename(tmp, this.file);
```

On a typical Linux/macOS box that produces a `0o644` file —
**world-readable on a shared system**. But this file stores
the user's complete personal calendar: titles, locations,
notes, and tags for every event. That's exactly the
surveillance signal a multi-tenant unix box would expose to
other users ("what meetings is this person in, with whom, at
what zoom link?").

The credential-store SIBLING in the same package
(`packages/calendar/src/credential-store.ts:98`) already
uses the user-only posture:

```ts
await fs.writeFile(tmp, ..., { encoding: "utf8", mode: 0o600 });
await fs.rename(...);
await fs.chmod(this.file, 0o600).catch(() => undefined);
```

The local-provider was the asymmetric outlier within its own
package. Goal 598 closed the same gap on three messaging
sidecars; this iteration closes it on the more sensitive
calendar-content store (higher data sensitivity tier — events
contain meeting titles + locations vs cursor positions).

Step-8 redirect note: same file-mode defect class as goal 598
but on a distinct package (`@muse/calendar` vs
`@muse/messaging`) and a higher-sensitivity data tier (user
calendar content vs polling cursors). Treated as a finishing
pass that closes the intra-package asymmetry; the credential
store at the SAME package level uses 0o600 + chmod, so the
local-provider was visibly inconsistent.

## Slice

- `packages/calendar/src/local-provider.ts:writeAll`:
  - Replaced `fs.writeFile(tmp, payload, "utf8")` with
    `fs.writeFile(tmp, payload, { encoding: "utf8", mode: 0o600 })`.
  - Added `await fs.chmod(this.file, 0o600).catch(() => undefined)`
    after `fs.rename` — defense-in-depth against filesystems
    that don't preserve the tmp's mode through rename. Matches
    the credential-store sibling byte-for-byte.
  - Added a short WHY comment on the threat model
    (title/location/notes are private; default umask leaks
    the schedule on a shared box).
- `packages/calendar/test/calendar.test.ts`:
  - Imported `statSync` from `node:fs` alongside the existing
    `mkdtempSync` / `rmSync` / `writeFileSync` imports.
  - One new test asserts `statSync(file).mode & 0o777 === 0o600`
    after BOTH the first `createEvent` write AND a subsequent
    write — pins the contract across the tmp+rename cycle so
    a future refactor that drops the post-rename chmod still
    fails the test if the rename ever doesn't preserve the
    mode.

## Verify

- `@muse/calendar` suite green (45 passed, +1 vs baseline 44,
  0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the
  `writeAll` back to the bare `"utf8"` write (no mode, no
  post-rename chmod) makes the new file-mode test fail — the
  file is created with the OS default umask (typically 0o644
  on Linux CI / 0o600 on a tightly-umasked dev box; the test
  asserts the explicit 0o600 invariant on either platform).
  Fix restored.
- `pnpm check` EXIT=0 (apps/api 258 passed, apps/cli 1040
  passed, every workspace green); `pnpm lint` 0/0; `pnpm
  guard:core` clean; `git status` shows only the two intended
  files.
- No LLM request-response wire path touched; `smoke:live` does
  not apply (per `testing.md` / iteration-loop Step 9). The
  defended path is the local calendar file's on-disk
  permissions.

## Status

Done. The local calendar provider now matches the
credential-store posture in its own package:

| File                                                                | Before               | After                                 |
| ------------------------------------------------------------------- | -------------------- | ------------------------------------- |
| `~/.muse/calendar.json` (via `LocalCalendarProvider.writeAll`)      | umask default (0644) | 0600 + post-rename chmod (**fixed**)  |
| `~/.muse/calendar-credentials.json` (via `FileCalendarCredentialStore`) | 0600 + chmod (unchanged) | unchanged                          |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a security-
hardening `fix:` on the local calendar persistence path,
recorded honestly with this backlog row — not a false metric.

## Decisions

- **Both mode-on-create AND post-rename chmod** — the more
  defensive of the two patterns. Matches the credential-store
  sibling's posture in the same package, and matches the
  `inbox-store.ts:89` pattern in `@muse/messaging` that
  goal 598's risk analysis flagged as the gold standard. The
  goal-598 sidecars used mode-on-create only (the simpler of
  the two patterns the codebase has); calendar events are
  meaningfully more sensitive than cursors, so the defensive
  posture is warranted here.
- **One test, two assertions.** Asserts the mode after
  `createEvent` (first write — the file is freshly created
  with the tmp's mode) AND after a subsequent `createEvent`
  (overwrite — pins that the rename + chmod pair preserves
  the user-only mode across updates). A single-assertion
  test would only cover the first-write path; the second
  call exercises the rename-over-existing-file branch.
- **`.catch(() => undefined)` on the chmod** — same defensive
  swallow that the credential store uses (line 88) and that
  `inbox-store.ts:89` uses. If the file vanishes between
  rename and chmod (race against another process), the
  primary write has already succeeded — failing the chmod
  on a missing file shouldn't surface as a writeAll error.
- **Did NOT extend the fix to other on-disk content stores in
  this iteration.** A grep for `fs.writeFile.*"utf8"$` finds:
  `packages/mcp/src/tasks-providers-local-file.ts:197`
  (tasks), `packages/mcp/src/notes-providers-local.ts:211`
  (notes body), `packages/mcp/src/proactive-notice-loop.ts:153`
  (proactive sidecar), `packages/mcp/src/personal-followup-llm-budget-store.ts:58`,
  `packages/mcp/src/personal-patterns-fired-store.ts:60`,
  `apps/cli/src/chat-history.ts`, etc. All same defect class,
  all need the same fix. Out of scope to keep this iteration
  tight; calendar was picked because its sibling in the same
  package shows the exact convention. Each remaining store
  is its own iteration.

## Remaining risks

- **`packages/mcp/src/tasks-providers-local-file.ts:197`**
  writes user tasks with the default umask. Same defect, same
  fix shape, deferred.
- **`packages/mcp/src/notes-providers-local.ts:211`** writes
  the body of a saved note file with the default umask.
  Notes can carry secrets, personal journaling, etc. — same
  defect class, deferred.
- **`apps/cli/src/chat-history.ts`** writes the
  `~/.muse/last-chat.json` history. Contains the user's
  prompts and assistant replies — high-sensitivity. Same
  defect, deferred.
- Each of the above deferred sites is a separate iteration
  in the same convention-sweep family; none are in this PR.
- Windows: `mode: 0o600` is effectively a no-op on Windows
  (POSIX permissions don't translate); the test's
  `statSync().mode & 0o777` may not equal `0o600` there.
  CI runs on Linux/macOS so the contract is pinned on the
  shipped platforms.
