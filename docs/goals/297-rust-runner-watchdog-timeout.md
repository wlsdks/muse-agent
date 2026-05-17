# 297 — the Rust runner boundary had no TS-side watchdog (a wedged runner hung the agent forever)

## Why

`invokeRustRunner` is the TS boundary to `crates/runner` — the
CLAUDE.md-mandated path for **risky local execution** (the
`run_command` `risk: "execute"` tool). The request's `timeoutMs`
is delegated to the Rust runner, which is supposed to enforce the
*command* timeout and report `timedOut`. But the TS side had **no
watchdog on the runner process itself**:

```ts
return new Promise((resolve) => {
  const child = spawn(runnerPath, [], …);
  child.on("error", … resolve(…));
  child.on("close", … resolve(…));
  child.stdin.end(`${JSON.stringify(request)}\n`);
});
```

If the runner binary wedges — a deadlock, a zombie, never
closing stdout, a bug that never honours its own deadline —
neither `error` nor `close` fires, the Promise **never settles**,
and the agent's tool call hangs forever with no recovery. This is
the same no-spawn-timeout class as goals 295/296, on the
**highest-stakes** surface (arbitrary approved command
execution), and the only spawn path that was still unbounded
after the voice fixes.

## Scope

`packages/tools/src/runner.ts`:

- Add an exported pure `runnerWatchdogMs(request)`:
  `request.timeoutMs + 5 000 ms` grace, or `120 000 ms` when no
  request timeout. The grace ensures the Rust runner always gets
  first chance to enforce + report its own deadline (the normal,
  informative `timedOut` path) — the watchdog only fires if the
  runner *process* outlives even that, so a legitimately long
  approved command is never killed early.
- `invokeRustRunner`: arm a `setTimeout(runnerWatchdogMs(...))`
  that `SIGKILL`s the child and settles a well-formed
  `{ ok:false, timedOut:true, error:"…watchdog and was killed" }`
  response. A single `settle()` (idempotent, clears the timer)
  replaces the bare `resolve`s so `error`/`close`/watchdog can't
  double-settle and the timer is always cleared on the normal
  paths. One short WHY comment records the
  delegated-timeout-vs-process-watchdog rationale.
- `runnerWatchdogMs` re-exported from the `@muse/tools` barrel.

Behaviour-preserving for a healthy runner: `error`/`close`
settle exactly as before and clear the watchdog; only a runner
process that outlives the (request-timeout + grace) cap is now
killed instead of hanging the agent.

## Verify

- `pnpm --filter @muse/tools test` — 68 pass / 1 skipped (+2).
  Instant unit tests pin `runnerWatchdogMs` (no timeout → 120 000;
  `timeoutMs:1000` → 6 000; `timeoutMs:1` → 5 001). An
  integration test spawns a **real** never-exiting executable
  (a `setInterval` shebang script, ignores stdin) as the runner
  with `timeoutMs:1`: `invokeRustRunner` resolves
  `{ timedOut:true, ok:false, error:/watchdog and was killed/ }`
  in well under the 15 s test cap (proves the process is actually
  SIGKILLed, not the test timing out). The existing
  injected-bridge / blank-command / invalid-JSON runner tests
  stay green (they use the `invokeRunner` seam, unaffected).
- `pnpm check` — every workspace green (tools 68, apps/cli 563,
  apps/api 160, all packages). `pnpm lint` — exit 0.
- No real-LLM request/response path touched (risky-execution
  process-spawn watchdog; no model round-trip). A live Qwen run
  cannot reproduce a wedged Rust runner on demand, so the
  deterministic real-hung-child test plus the pure unit tests are
  the rigorous verification — same stance as the timeout/limit
  goals 295 / 296 / 263 / 284.

## Status

done — the Rust runner boundary now has a request-timeout-aware
TS watchdog that SIGKILLs a wedged runner process and fails fast
with a clear timedOut response, so risky local execution can no
longer hang the agent forever. Healthy runs are unchanged. Every
child-process spawn path in the codebase (STT 295, TTS 296,
runner 297) is now timeout-bounded.
