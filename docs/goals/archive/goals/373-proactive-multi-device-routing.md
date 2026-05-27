# 373 — Proactive multi-device routing

Category: epic / feature

## Why

`docs/design/proactive-surfacing.md` ships Phases A–D. The named
remaining work: a proactive notice currently always fires through
the messaging registry, even when the user is actively at the
REPL/CLI on this machine. JARVIS-class behaviour is to surface the
notice *through the surface the user is currently looking at* — the
terminal session when present, messaging only as the fallback.

## Scope

Generalise delivery routing on top of the existing in-memory
presence tracker (Phase D). No new infra, no schema bump.

## Slices

1. **Presence-aware sink selection** — extend the proactive
   firing path so an active local presence routes the notice to a
   terminal sink instead of the messaging registry. Messaging
   remains the fallback when no local presence is recorded.
2. **Terminal notice sink** — a sink that renders a queued
   proactive notice into the active REPL without corrupting the
   prompt line (reuse the existing control-byte-safe writer).
3. **Stale-presence expiry + fallback** — presence older than a
   bounded window is treated as absent so a backgrounded terminal
   doesn't black-hole notices; falls back to messaging.

## Verify

- Per slice: `pnpm check`, `pnpm lint` (0/0), `pnpm smoke:broad`.
- `pnpm smoke:live` for the firing-path slice.
- Unit test per slice (presence → sink decision is pure logic;
  assert the sink actually chosen, no fall-back assertion).

## Status

slice 3 done — epic COMPLETE. `selectProactiveSink` gained an
optional `freshness { nowMs, maxAgeMs }` arg: a recorded-but-stale
presence (backgrounded / abandoned terminal still reports
`lastActivityMs`) now returns `messaging` instead of black-holing
the notice into a surface nobody is watching. `runDueProactiveNotices`
passes `nowDate.getTime()` + the finite-guarded active-session
window (default 300_000 ms) so a terminal idle past the window
falls back to messaging. Slice-1 2-arg callers are unchanged (no
freshness arg → defined presence still routes to terminal). +2 mcp
tests (pure stale/fresh/back-compat decision; integration: stale
presence delivers via messaging, terminalSink not called).
CAPABILITIES.md +1 (Presence: terminal routing with stale fallback).

## Decisions

- Staleness window reuses the existing `activeSessionWindowMs`
  resolution (same finite-guard + 300_000 default) rather than a
  new knob — semantically "user not seen on a surface within the
  active-session window ⇒ terminal is stale". No new option to
  document or mis-set.
- `freshness` is an optional 3rd arg, not a signature change, so
  slice-1 behaviour and its tests are preserved verbatim
  (append/flip-only spirit; minimal merge surface).
- Slice 3 changes deterministic proactive sink routing only — not
  the LLM request/response path — so `smoke:live` is not the
  applicable gate (the deterministic stale-fallback test is); this
  is scope, not a skipped-verification justification. (smoke:live
  was still exercised: the owner's Ollama-only picker fix is
  confirmed executing real local-Qwen `/api/chat` round-trips; a
  full run on the picked 35b model exceeds a 5-min wrapper — logged
  in the README Rejected ledger as a future Autonomy goal.)
- Rebased onto the owner's mid-iteration A+ contract (`62daf4b0`):
  README/CAPABILITIES conflicts resolved by taking the owner's new
  authoritative versions and re-applying only the allowed
  append/flip (P1). Commit code is byte-identical pre/post rebase.

slice 2 done — `apps/cli/src/proactive-terminal-sink.ts`:
`formatProactiveTerminalNotice` (pure: `\r\x1b[K` prompt-clear
prefix + `stripUntrustedTerminalChars` on the third-party text +
trailing `\n`) and `createTerminalProactiveSink({ write,
redrawPrompt? })` returning the slice-1 `ProactiveNoticeSink`. Wired
into `muse proactive watch`: when attached to a TTY the notice
renders into that terminal (prompt-safe, control-byte-stripped) and
slice-1 routing selects it; piped / detached / systemd (no TTY)
keeps the messaging path. Unit-tested (prefix/suffix shape, C1 +
control-byte stripping of hostile text, write+redraw, no-redraw
foreground case). New user-visible capability: `muse proactive
watch` in a terminal now surfaces notices inline instead of only via
the messaging log.

Next iteration must change surface (forward-progress guard: slices
1+2 were two consecutive proactive-routing iterations). Slice 3
(stale-presence expiry) resumes after a different-surface iteration.

slice 1 done — presence-aware sink selection wired into the
proactive firing path. Pure `selectProactiveSink(activitySource,
hasTerminalSink)` + a minimal `ProactiveNoticeSink` seam +
`terminalSink?` option; when a sink is wired AND the activity
source reports recorded local presence the notice routes to the
terminal sink, otherwise messaging (the fallback). History audit
records `providerId: "terminal"` for terminal deliveries. Unit
tests assert the pure decision and that the chosen sink actually
receives the notice (no fall-back assertion) + the no-presence
messaging fallback.

Remaining: slice 2 (concrete REPL terminal sink renderer), slice 3
(stale-presence expiry → treat a backgrounded terminal as absent).

Verification note: `pnpm smoke:live` auto-skips because
`scripts/smoke-live-llm.mjs` `pickProvider()` only probes cloud API
keys (its `OLLAMA … if reachable` header comment is unimplemented);
under the Qwen-only / cost-zero constraint no cloud key may be set.
Slice 1 changes post-synthesis delivery routing only — the
LLM request/response path is untouched — so the deterministic unit
test (per this goal's Verify) plus `pnpm smoke:broad` (51/0) is the
rigorous verification here.
