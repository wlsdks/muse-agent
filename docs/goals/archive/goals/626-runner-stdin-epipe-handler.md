# 626 — `invokeRustRunner` routes the stdin write through `writeRunnerStdin`, which registers an `error` listener BEFORE `.end(...)` so an EPIPE from a runner that closed its stdin before consumption can't crash the parent process

## Why

`packages/tools/src/runner.ts:invokeRustRunner` spawns the Rust
runner child process and pipes the JSON request body in via
stdin. Pre-fix:

```ts
child.stdout.on("data", ...);
child.stderr.on("data", ...);
child.on("error", ...);
child.on("close", ...);
child.stdin.end(`${JSON.stringify(request)}\n`);
```

The stdin Writable has NO `error` listener. A runner that exits
before consuming stdin closes the pipe — the parent's
`.end(...)` write then emits an `error` event on the stdin
stream with an EPIPE-like cause. Node's EventEmitter contract:
**an `error` event with no registered listener throws as an
uncaught exception and crashes the whole Node process.**

This is the exact hazard `packages/voice/src/piper.ts:202`
already defends against:

```ts
// piper.ts
child.stdin?.on("error", () => undefined);
child.stdin?.write(stdin);
child.stdin?.end();
```

The piper.ts docstring documents the threat model:
> A child that exits before consuming stdin (bad model,
> immediate crash) makes this write emit EPIPE on the stdin
> stream; an unhandled stream 'error' crashes the whole
> process. The real outcome is the exit code / timeout the
> close handler already reports, so absorb the write failure.

`runner.ts` carries the identical spawn + stdin write pattern
and was the missed sibling. A runner binary that panics
immediately, was SIGKILLed by the watchdog while stdin write
was in flight, or simply doesn't read its stdin produces the
same uncaught error.

User-visible: the CLI crash isn't a runner exit-code error
(the `child.on("close")` handler would have reported that
cleanly) — it's a raw uncaught exception that the parent
process never has a chance to translate into a tool error.
Operators see Node's "Uncaught error event" stack trace
instead of a structured `{ ok: false, error: "..." }` outcome.

Step-8 redirect: not strict-parse (625), not HTTP timeout
(624), not diagnostic classification (623), not boolean
spelling (622). Defect class is "child-process stream error
listener registration" — fresh in the recent window.

## Slice

- `packages/tools/src/runner.ts`:
  - New exported helper
    `writeRunnerStdin(child: ChildProcess, request:
    RunnerCommandRequest): void` that:
    - Bails silently if `child.stdin` is null (spawn failed
      before stdio attached — the outer `child.on("error")`
      already covers this path).
    - Registers a no-op `error` listener on stdin BEFORE the
      `.end(...)` call, mirroring piper.ts's pattern.
    - Calls `stdin.end(JSON.stringify(request) + "\n")` as
      before.
  - `invokeRustRunner`'s tail line
    `child.stdin.end(\`${JSON.stringify(request)}\\n\`)` swapped
    for `writeRunnerStdin(child, request)` — single call site,
    same behavior, with the defensive listener in place.
  - Helper exported through the `@muse/tools` barrel so the
    test can drive it directly without spawning a real process.
- `packages/tools/test/tools.test.ts`:
  - Two new tests in the `Rust runner watchdog` describe:
    - **Error listener registered** — constructs a
      `node:stream.PassThrough` as a fake stdin, passes it
      inside a `{ stdin } as ChildProcess` shim, calls
      `writeRunnerStdin`. Asserts `() =>
      stdin.emit("error", new Error("EPIPE simulated"))` does
      NOT throw. EventEmitter's contract: emit('error')
      throws an uncaught exception IFF there's no listener.
      Pre-fix the test would fail with `Received: "Error:
      EPIPE simulated"` — exactly the symptom the parent
      process would surface.
    - **Null stdin no-op** — passes `{ stdin: null }`, asserts
      the call doesn't throw. Covers the
      spawn-failed-before-stdio-attached path.

## Verify

- `@muse/tools` suite green (75 passed + 1 always-skipped
  real-runner test, +2 vs baseline 73, 0 failed); tsc strict
  EXIT=0.
- **Clean-mutation-proven** (Edit-based): removing the
  `stdin.on("error", () => undefined)` line in
  `writeRunnerStdin` makes the listener-registered test fail
  with `Received: "Error: EPIPE simulated"` (the EventEmitter
  emit rethrew the error because no listener was registered)
  — exactly the pre-fix uncaught-event symptom. Fix restored,
  suite back to all green.
- `pnpm check` EXIT=0 (apps/api 261 passed, apps/cli 1063
  passed, every workspace green); `pnpm lint` 0/0; `pnpm
  guard:core` clean; byte-scan clean on both touched files;
  `git status` shows only the two intended files plus this
  goal doc.
- No LLM request-response wire path touched directly; the
  Rust runner is the local-execution boundary for risky tool
  calls. `smoke:live` doesn't apply.

## Status

Done. The runner's stdin write path is now resilient to the
"runner closed stdin before consuming" hazard, matching the
piper.ts pattern:

| Scenario                                | Before                       | After                       |
| --------------------------------------- | ---------------------------- | --------------------------- |
| Runner consumes stdin normally          | request lands; close → ok    | unchanged                   |
| Runner exits before reading stdin       | **uncaught EPIPE → crash**   | listener absorbs; close handler reports the exit code (**fixed**) |
| Spawn failed before stdio attached      | `child.stdin` is null → TypeError on `.end()` | no-op, falls through to outer `child.on("error")` (**fixed**) |
| Runner SIGKILLed mid-write (watchdog)   | **uncaught EPIPE if write timing aligns** | listener absorbs (**fixed**) |
| Runner exits after consuming            | close → parsed response       | unchanged                   |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a robustness /
child-process stream-handling parity `fix:` matching the
sibling piper.ts pattern, recorded honestly with this backlog
row — not a false metric.

## Decisions

- **Extracted helper instead of inlined defense.** Inlining
  `child.stdin.on("error", () => undefined)` directly in
  `invokeRustRunner` would work but isn't mutation-testable
  without spawning a real misbehaving child. Extracting to
  `writeRunnerStdin(child, request)` makes the contract
  testable via a `PassThrough` fake stdin and a typed
  `ChildProcess` shim — the listener registration is then
  pinned structurally via `emit("error", ...)` not throwing.
- **No-op listener (`() => undefined`)**, not a logger. The
  close handler already reports the exit code; the EPIPE on
  stdin is the symptom, not the root cause. Logging it would
  add noise. Matches piper.ts exactly.
- **`if (!stdin) return` early-bail.** A failed spawn leaves
  `child.stdin === null`. The outer `child.on("error")`
  handler in `invokeRustRunner` already catches the spawn
  failure and resolves the promise with a structured error.
  The helper just needs to not throw in that case.
- **Test uses `PassThrough`** rather than mocking
  `node:child_process.spawn`. `PassThrough` is a real
  `Writable + EventEmitter`, so the EventEmitter `error`
  contract is exercised exactly as a production stdin would
  exercise it. No vi.mock hooks needed.
- **`emit("error", new Error(...))` returns normally IFF a
  listener is registered.** EventEmitter's documented
  behavior — if there are no listeners for `error`, the
  argument is thrown synchronously from `.emit()`. The
  `not.toThrow()` assertion is the exact inverse of that
  contract.
- **Mutation choice.** Reverted only the
  `stdin.on("error", () => undefined)` line — the realistic
  regression a maintainer might write while "removing the
  apparently no-op listener for clarity." The mutation test
  catches it with the exact `Received: "Error: EPIPE
  simulated"` symptom.
- **Did NOT also add stdout / stderr `error` listeners.**
  Those are read streams; errors on them are rare and the
  existing `child.on("error")` catches process-level errors.
  The stdin write path is the documented hazard surface
  (piper.ts called it out specifically); scope-limited fix.

## Remaining risks

- **Other `child.stdin.end(...)` sites in the codebase**
  weren't audited in this iter. Spot-check candidates:
    - `packages/voice/src/piper.ts` — already hardened.
    - `packages/voice/src/whisper-cpp.ts` — uses stdin? Check.
    - `apps/cli/src/commands-listen.ts` — uses sox via
      spawnRec; doesn't write to stdin.
    - `apps/cli/src/commands-export.ts` — uses tar via spawn;
      no stdin write.
  The runner.ts case was the most exposed (every risky
  local-tool execution flows through it); other sites are
  less hot.
- **`if (!stdin) return`** silently no-ops when stdin is
  null. The outer `child.on("error")` handler in
  `invokeRustRunner` covers the spawn-failure path, but if a
  future caller wires `writeRunnerStdin` without that outer
  handler they'd silently not write the request body and
  hang. Out-of-scope here — the helper is exported with the
  same contract as the inlined call it replaces.
- **The `close` handler still returns "runner returned
  invalid JSON"** when the runner crashed before producing
  output. That's the intended behavior — the parent CLI
  surfaces this as the tool's error. The stdin EPIPE was
  the pre-fix CRASH that bypassed even reaching the close
  handler; this fix routes everything through the structured
  close path.
