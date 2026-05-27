# 642 — `invokeRustRunner` registers no-op `error` listeners on `child.stdout` and `child.stderr` via a new exported `attachReadStreamErrorAbsorber` helper, so an OS-level pipe error on the read side can't crash the parent — symmetric to the stdin-write absorber goal 626 added

## Why

`packages/tools/src/runner.ts:invokeRustRunner` spawns the Rust
sandbox runner child process and attaches `data` listeners on
its stdout and stderr:

```ts
child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
```

Goal 626 already registered an `error` absorber on the
STDIN write side (an EPIPE on `.end(...)` when the child
closed stdin before consuming). But the read side (stdout /
stderr) had no `error` listener.

Node's EventEmitter contract: when an `error` event fires on
a stream with NO registered listener, the underlying argument
is **thrown as an uncaught exception** — crashing the parent
process. The hazard is:

- Rare in normal operation (Readable streams emit `error`
  only on pipe-level corruption, not on EOF or empty data).
- Realistic on weird platforms: kernel pipe corruption under
  resource pressure, sandbox tear-down mid-read (the Rust
  runner is the local-execution boundary, sandbox APIs can
  rip the pipe out from under Node), antivirus / file-system
  filter middleware interfering, NFS-mounted tmp paths.
- The parent CLI process disappearing from a stream-level
  error isn't recoverable by the structured error handler
  the runner already has — `child.on("error")` and
  `child.on("close")` catch process-level events, not
  stream-level ones.

The piper.ts docstring (line 197-201) already names this
threat model:

> A child that exits before consuming stdin (bad model,
> immediate crash) makes this write emit EPIPE on the stdin
> stream; an unhandled stream 'error' crashes the whole
> process.

Same applies to the READ side — a stream error on stdout/
stderr emits `error` on the Readable; without a listener,
the parent crashes. Goal 626 closed the stdin write-side
hazard for the runner; this iter closes the stdout/stderr
read-side hazard.

### Defect class

**Sibling-pattern to goal 626** (child-process stream error
listener) but on a different stream direction (read vs.
write). Goal 626 was 16 iterations back, well outside the
last-10 window. Fresh.

Recent classes:
- 641: cacheTtlMs finite-guard
- 640: word-boundary keyword matching
- 639: keyword dedup
- 638: lenient base64url decode (auth)
- 637: lenient base64 decode (loopback)
- 636: HTTP timeout
- 635: per-file concurrent write (memory)
- 634: sort tiebreaker
- 633: surrogate-pair truncation
- 632: tilde-expansion

Stream-error-listener has not been hit since 626.

## Slice

- `packages/tools/src/runner.ts`:
  - New exported helper `attachReadStreamErrorAbsorber
    (stream: NodeJS.ReadableStream | null): void`:
    - Bails silently if `stream` is null (spawn race / pre-
      stdio-attach).
    - Registers a no-op `error` listener so the
      EventEmitter `error`-with-no-listener crash is averted.
  - Called twice in `invokeRustRunner` — once for
    `child.stdout`, once for `child.stderr`, BEFORE the
    `data` listeners are attached (so an error fired
    immediately on stream creation can't slip past).
  - Single short JSDoc comment names the contract — the
    runner already has dedicated JSDoc style on its other
    helpers (`writeRunnerStdin`, `runnerWatchdogMs`).
- `packages/tools/src/index.ts`:
  - Add `attachReadStreamErrorAbsorber` to the re-exports
    so the test can drive it directly.
- `packages/tools/test/tools.test.ts`:
  - Two new tests in the existing `Rust runner watchdog`
    describe (which already has the goal 626 stdin
    absorber tests):
    1. **Registers no-op error listener** — construct a
       `PassThrough` stream (real Readable, real
       EventEmitter), pass to `attachReadStreamErrorAbsorber`,
       emit `error` on the stream. Assert the emit does NOT
       throw. Repeat for a second stream to pin the contract
       per-call. EventEmitter's documented contract: `emit
       ('error')` throws synchronously IFF no listener is
       registered — the `not.toThrow` assertion is the exact
       inverse.
    2. **Null stream no-op** — `attachReadStreamErrorAbsorber
       (null)` must not throw (spawn-failed-before-stdio-
       attached path).

## Verify

- `@muse/tools` suite green (78 passed, +2 new tests in the
  existing describe, 1 always-skipped real-runner test, 0
  failed).
- **Clean-mutation-proven** (Edit-based): reverting only the
  `stream.on("error", () => undefined);` line inside the
  helper body (leaving the runner.ts call sites intact)
  makes the first new test fail with the EXACT pre-fix
  symptom: `Received: "Error: EPIPE on stdout"` — the
  EventEmitter emit rethrew because no listener was
  registered. Restoring the line flips it green. The other
  77 tests pass both pre- and post-fix.
- `pnpm check` green: apps/api 261/261, apps/cli 1101/1101,
  every workspace; tsc strict EXIT=0.
- `pnpm lint` 0/0, `pnpm guard:core` clean, byte-scan clean
  on all three touched files.
- No LLM request/response wire path touched (the runner is
  the local-tool-execution boundary). `smoke:live` doesn't
  apply.

## Status

Done. `invokeRustRunner`'s child-process stdio is now
symmetric on both directions:

| Scenario                                       | Before                                | After                       |
| ---------------------------------------------- | ------------------------------------- | --------------------------- |
| Normal stdin write to runner                   | OK                                    | unchanged                   |
| stdin EPIPE (runner closed stdin pre-read)     | absorber catches (goal 626)           | unchanged                   |
| Normal stdout / stderr read                    | OK                                    | unchanged                   |
| **stdout pipe error mid-read**                 | **uncaught crash**                    | absorbed (**fixed**)        |
| **stderr pipe error mid-read**                 | **uncaught crash**                    | absorbed (**fixed**)        |
| child.on("error") (process-level spawn fail)   | existing handler                      | unchanged                   |
| child.on("close") (process-level exit)         | existing handler                      | unchanged                   |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a robustness
/ child-process stream-handling parity `fix:` matching the
stdin pattern from 626. Recorded honestly with this backlog
row.

## Decisions

- **Extracted helper instead of inlined `stream.on("error",
  ...)` calls.** Same reasoning as goal 626 — inlining
  isn't mutation-testable without spawning a real
  misbehaving child. The helper takes any `NodeJS.ReadableStream`
  and a `null` (the spawn-race edge), and the test drives it
  directly with a `PassThrough`.
- **`NodeJS.ReadableStream | null` signature**, not the
  Node-specific `ChildProcessByStdio` types. Lets the helper
  accept any Readable (including `PassThrough` in tests,
  any future spawned child's outputs). The null branch
  covers the spawn-race window where the child process
  exists but stdio hasn't attached yet.
- **No-op listener (`() => undefined`)**, not a logger. The
  `child.on("error")` and `child.on("close")` handlers
  already capture process-level error info. Logging stream-
  level pipe errors would add noise without diagnostic
  value (the real outcome is already reported).
- **Called BEFORE the `data` listeners.** Defensive — if
  an `error` event fires synchronously on stream attach (an
  edge case but technically possible for a stream that
  errored before Node attached it to the child), the
  absorber is in place. Matching `data`-after-`error`
  ordering also keeps the call site readable: "register
  error absorber, then start consuming."
- **Did NOT also add a write-side absorber on child.stdin
  redundantly.** Goal 626's `writeRunnerStdin` already
  handles it via the `stdin.on("error", () => undefined)`
  inside that function. Symmetric helpers for symmetric
  problems.
- **Did NOT sweep the other sibling spawn sites** in this
  iter (`piper.ts`, `whisper-cpp.ts`, `macos-provider.ts`,
  `linux-libnotify-provider.ts`). Each carries the same
  read-side gap (data listeners without error absorbers).
  Bounded scope to the runner (highest-impact, every risky
  tool call). The others are follow-up iterations.
- **Mutation choice — helper body, not call sites.** Reverting
  the helper body (removing the `stream.on("error", ...)`
  line) lets the helper still be called from `runner.ts` but
  with no effect. The first new test fails with the literal
  `Error: EPIPE on stdout` (EventEmitter rethrew the
  argument). The runner.ts integration is implicitly tested
  by the live-runner skip test — not flipped by this
  mutation but covered by integration paths.

## Remaining risks

- **Other spawn sites** still vulnerable: `packages/voice/src/
  piper.ts:183`, `packages/voice/src/whisper-cpp.ts:212`,
  `packages/calendar/src/macos-provider.ts:209-210`,
  `packages/messaging/src/linux-libnotify-provider.ts:66`,
  `apps/cli/src/voice-playback.ts` (playAudioWithWatchdog).
  Each is its own iter — sibling-pattern, same fix shape.
  Picked the runner (the documented "risky local execution
  flows through `crates/runner`" boundary, per CLAUDE.md)
  first because it carries the highest blast radius.
- **`PassThrough` is a Duplex but the helper accepts
  `ReadableStream`.** Duplex extends both Readable and
  Writable; the listener registration uses the EventEmitter
  surface so works for either. No semantic concern.
- **Error events on `data` listener callbacks** (the
  callback ITSELF throwing) are NOT caught by the absorber —
  uncaught exceptions inside a listener still propagate.
  The current `data` listener body is a pure
  `Buffer.push(chunk)` — guaranteed not to throw. If a
  future change adds processing logic, that needs its own
  try/catch.
- **`PassThrough` in test** doesn't exactly mirror a child
  process pipe (PassThrough is in-process; child stdout is
  a libuv pipe). But the EventEmitter `error`-without-
  listener semantics is identical — same crash path. The
  test pins the listener registration, which is what the
  fix actually does; the underlying transport doesn't
  matter for that contract.
