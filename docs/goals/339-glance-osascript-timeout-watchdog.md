# 339 — `muse glance` osascript spawn had no timeout watchdog (could hang forever)

## Why

The established child-process-watchdog sweep (goals 295
whisper-cpp, 296 piper, 297 Rust runner, 303 macOS *calendar*
osascript) requires every risky spawn to have a SIGKILL
timeout. `muse glance` (goal 089, the flagship
"know-what's-on-screen" capability) was **missed**:
`runOsascript` in `commands-glance.ts` did

```ts
const child = spawn("osascript", ["-e", OSASCRIPT_SOURCE], …);
child.on("error", reject);
child.on("close", (code) => code === 0 ? resolve(stdout) : reject(…));
```

— no timer, no SIGKILL. The `OSASCRIPT_SOURCE` drives
`System Events` UI scripting and a `keystroke "c" using
{command down}` clipboard read; an **unanswered Accessibility
permission prompt** or a wedged/unresponsive frontmost app
leaves osascript blocked, so `muse glance` (and any caller
awaiting it) **hangs forever** with no output and no error —
the exact failure mode goal 303 closed for the calendar
osascript, still open here.

## Scope

`apps/cli/src/commands-glance.ts` — `runOsascript`:

- Add the **same single-settle + SIGKILL watchdog** goal 303
  uses for the calendar osascript: a `settled` flag, a
  `finish(action)` helper that `clearTimeout`s and runs once,
  and a `setTimeout` that `child.kill("SIGKILL")`s and rejects
  with an actionable message (names the unanswered-Accessibility-
  prompt cause). 30_000 ms default — identical to
  `DEFAULT_MACOS_TIMEOUT_MS` in the calendar provider, for
  cross-surface consistency. `error`/`close` now route through
  `finish` so a post-kill late `close` can't double-settle.
- `runOsascript` gains an optional injected `spawnFn`
  (defaults to the real `spawn`) purely for testability — the
  sole production caller `runOsascript()` is unchanged.

Behaviour-preserving for the normal path (clean exit still
resolves stdout; non-zero exit / spawn error still reject with
the same messages); the only new behaviour is the bounded
timeout.

## Verify

- New `apps/cli/src/commands-glance.test.ts` (the command had
  **no test**): 9 cases. `parseOsascriptGlance` — three-line
  split, `missing value`/blank → empty, CRLF + whitespace
  collapse, and untrusted-terminal-control stripping (ESC built
  via `String.fromCharCode(27)`, never a raw byte — goal-227
  safe). `runOsascript` — clean-exit resolve, non-zero-exit
  reject, spawn-error reject, **fake-timer timeout → rejects
  `/timed out after 30000ms/` and `child.kill` called with
  `SIGKILL`**, and a double-settle guard (a late `close` after
  the timeout is ignored).
- `pnpm --filter @muse/cli test` — 572 pass (+9; new file).
  `pnpm check` — every workspace green (apps/cli 581 incl. the
  test/ glob, apps/api 161, all packages). `pnpm lint` — exit
  0. The goal-227 enforcement test (328) stays green.
- No real-LLM request/response path touched (deterministic
  child-process control flow). The deterministic suite —
  including the genuine fake-timer watchdog test — is the
  rigorous verification.

## Status

done — `muse glance`'s osascript spawn now SIGKILLs and rejects
after 30 s instead of hanging indefinitely on an unanswered
Accessibility prompt or a wedged UI-scripting target, with a
single-settle guard. The macOS-osascript watchdog class is now
closed for both the calendar provider (303) and `muse glance`
(339), and the previously-untested flagship command has direct
coverage.
