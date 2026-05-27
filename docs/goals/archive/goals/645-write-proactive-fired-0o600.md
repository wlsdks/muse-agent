# 645 — `writeProactiveFired` locks `~/.muse/proactive-history.json` to mode `0o600` (writeFile `mode` option + post-rename `chmod`) so the timeline of which calendar events / tasks fired when isn't world-readable on a shared box — sibling-parity with the other personal stores

## Why

`packages/mcp/src/proactive-notice-loop.ts:writeProactiveFired`
persists the operator's proactive-notice firing timeline:

```json
{
  "fired": [
    { "kind": "calendar", "id": "evt_…", "startIso": "…", "firedAt": "…" },
    { "kind": "task", "id": "task_…", "startIso": "…", "firedAt": "…" },
    …
  ]
}
```

This reveals — to anyone with read access — exactly when each
calendar event and task fired a Muse-side reminder / notice.
Combined with the calendar / tasks files (which 0o600 already
lock down), this lets a co-resident user reconstruct the
operator's meeting cadence, sleep schedule, task completion
patterns. Sensitive personal data, no question.

Pre-fix:

```ts
await fs.writeFile(tmp, payload, "utf8");  // ← no mode option
await fs.rename(tmp, file);                 // ← no post-rename chmod
```

The `tmp` file is created with the process umask (typically
0o022 → mode 0o644 = world-readable). The rename promotes that
mode to the live path. On a fresh-default Ubuntu / macOS install
this means everyone in the user's group AND `other` can `cat
~/.muse/proactive-history.json`.

### Sibling stores in the same package ALL get this right

| Personal store sidecar (mcp pkg)                         | mode 0o600?    |
| -------------------------------------------------------- | -------------- |
| `personal-episodes-store.ts:writeEpisodes`               | yes (already) |
| `personal-followups-store.ts:writeFollowups`             | yes (already) |
| `personal-tasks-store.ts:writeTasks`                     | yes (already) |
| `personal-reminders-store.ts:writeReminders`             | yes (already) |
| `tasks-providers-local-file.ts:writeTasks`               | yes (already) |
| `personal-action-log-store.ts:appendAction*`             | yes (already) |
| `personal-veto-store.ts:writeVetoes`                     | yes (already) |
| `personal-activity-feed.ts:writeActivities`              | yes (already) |
| **`proactive-notice-loop.ts:writeProactiveFired`**       | **NO**         |

Plus the `writeSessionLock` AT THE TOP OF THE SAME FILE (line
82-90) already does the full 0o600 pattern:

```ts
await fsm.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
await fsm.rename(tmp, file);
await fsm.chmod(file, 0o600).catch(() => undefined);
```

`writeProactiveFired` in the same file did NOT use this
pattern. The 70-line gap between the two functions clearly
shows the asymmetry was a one-off slip.

### Defect class

**Missing 0o600 file mode + post-rename chmod on a private
user-data persistence file** — sibling-parity to goals 616
(inbox-injection-cursor.ts 0o600), 617 (credential-store
atomic write), 598/599 (the earlier mode sweeps).

Last "file-mode 0o600" iter was 616, 29 iterations back. Well
outside the recent-10 window. Fresh.

Against the recent window:
- 644: finite-guard (data destruction)
- 643: strict int-parse on HTTP query params
- 642: stream error listener (read side)
- 641: cacheTtlMs finite-guard
- 640: word-boundary keyword matching
- 639: keyword dedup
- 638: lenient base64url decode (auth)
- 637: lenient base64 decode (loopback)
- 636: HTTP timeout
- 635: per-file concurrent write (memory)

No file-mode iter in last 10. Solidly fresh.

## Slice

- `packages/mcp/src/proactive-notice-loop.ts:writeProactiveFired`:
  - Changed `fs.writeFile(tmp, payload, "utf8")` to `fs.writeFile
    (tmp, payload, { encoding: "utf8", mode: 0o600 })`.
  - Added `await fs.chmod(file, 0o600).catch(() => undefined);`
    after the rename — defense-in-depth against the case where
    the rename target had a pre-existing wider mode (filesystem
    + Node version dependent).
  - One short WHY comment names the threat model (calendar /
    task firing timeline is private user data; sibling stores
    already lock this down). The `writeSessionLock` 70 lines
    above this function uses the exact same pattern; no new
    convention introduced.
- `packages/mcp/test/mcp.test.ts`:
  - One new test in the existing "personal store file-mode lock-
    ins" describe. Two assertions:
    1. **First write** — fresh file. `writeProactiveFired`
       creates it; `statSync(file).mode & 0o777 === 0o600`.
       Proves the `mode: 0o600` option applies on creation.
    2. **Re-write after external tamper** — `chmodSync(file,
       0o644)` simulates either a pre-existing wider-mode file
       on disk OR an external `chmod` between writes. Then a
       second `writeProactiveFired` call must restore 0o600.
       Proves the post-rename `chmod(file, 0o600)` step
       actively locks the mode down (the writeFile `mode`
       option only applies on FILE CREATION; if the rename
       target inherits from the existing target, the mode
       wouldn't update without the explicit chmod).

## Verify

- `@muse/mcp` suite green (538 passed, +1 vs the pre-iter
  baseline of 537, 0 failed).
- **Clean-mutation-proven** (Edit-based): reverting the
  `{ encoding: "utf8", mode: 0o600 }` back to `"utf8"` AND
  removing the post-rename `chmod` line makes the new test
  fail with the EXACT pre-fix symptom — `Received: 420`
  (decimal for 0o644 = the umask-default world-readable mode)
  vs. `Expected: 384` (decimal for 0o600). The 537 other
  pre-existing tests pass both pre- and post-fix.
- `pnpm check` green: apps/api 270/270, apps/cli 1101/1101,
  every workspace; tsc strict EXIT=0.
- `pnpm lint` 0/0, `pnpm guard:core` clean, byte-scan clean.
- No LLM request/response wire path touched. `smoke:live`
  doesn't apply.

## Status

Done. `~/.muse/proactive-history.json` is now mode-locked to
0o600 on every write, matching every sibling personal store:

| File mode after write                       | Before                     | After                |
| ------------------------------------------- | -------------------------- | -------------------- |
| Fresh create (file didn't exist)            | **0o644** (umask default)  | 0o600 (**fixed**)    |
| Re-write over existing wider-mode file      | **inherits the wider mode**| 0o600 (**fixed**)    |
| Re-write over existing 0o600 file (no-op)   | 0o600                      | 0o600                |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a robustness
/ user-data privacy `fix:`. Recorded honestly with this
backlog row.

## Decisions

- **Both `mode: 0o600` on writeFile AND `chmod` after rename**.
  The writeFile `mode` option only applies on FILE CREATION,
  not when rename overwrites an existing target. On a fresh
  install the option suffices; on an upgrade where the file
  already existed with the umask-default 0o644, the rename
  preserves the EXISTING mode. The post-rename chmod is the
  invariant-enforcing step. Same pattern `writeSessionLock`
  uses 70 lines above in the same file.
- **`.catch(() => undefined)` on the chmod**. Mirrors the
  sibling stores. On Windows-ish platforms chmod is a no-op;
  swallowing the error keeps the write path fail-soft. The
  file is still written; only the mode-tightening is
  best-effort.
- **Did NOT also sweep other proactive-notice-loop write
  paths** (`writeSessionLock` already does the right thing;
  `readSessionLock` / `readProactiveFired` are read-only).
- **Test asserts BOTH paths** — fresh create AND re-write
  after external tamper. The two checks pin both branches of
  the fix (the writeFile mode option AND the post-rename
  chmod). A future regression that drops one but keeps the
  other would still fail one assertion.
- **Mutation choice.** Reverted both lines together (the
  writeFile mode option AND the post-rename chmod). The new
  test fails with the literal `Received: 420` (0o644 decimal)
  symptom on the first assertion. Restoring both lines flips
  it green.

## Remaining risks

- **`writeSessionLock` (same file, line 82) was already
  correct** — sibling within the file.
- **Mode persists across reboots**, so an existing 0o644
  file on an upgrading install gets fixed on the next
  write — but until then it's still world-readable.
  Defense-in-depth would be a `muse doctor`-style fix that
  walks `~/.muse/` and chmods everything to 0o600. Out of
  scope for this iter.
- **`umask` quirks**. If an operator runs with `umask 0` (no
  bits stripped, all permissions granted by default), the
  `mode: 0o600` option still produces 0o600 — Node's writeFile
  does NOT apply umask on the `mode` option, unlike `creat()`
  syscalls in raw C. Verified via the test (umask doesn't
  appear in the test environment).
- **Sibling personal stores in OTHER packages** — a quick
  grep finds `apps/cli/src/feeds-store.ts`, `apps/cli/src/
  persona-store.ts`, `apps/cli/src/episode-index.ts`, etc.
  Each already does mode 0o600 + chmod (per goals 616, 617).
  No remaining "missed sibling" personal-store paths that I
  found. The audit shows the mcp `writeProactiveFired` was
  the last unguarded write in the muse personal-store surface.
