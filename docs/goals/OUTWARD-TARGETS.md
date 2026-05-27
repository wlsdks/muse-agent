# Outward Target Map — the loop's self-directed north star

The loop sets and evolves its own direction. A human intervenes
only by direct command. Until then the loop decides what "outward"
means, using its own judgement of what a great personal AI
assistant does.

## North star

Muse is a personal AI assistant in the spirit of JARVIS: it
**proactively speaks first** from real context (schedule, events,
patterns, follow-ups) AND **responds instantly and completely the
moment it is addressed**, running the full agent loop to finish the
task. Two qualities define every outward goal:

- **Proactive** — initiates from real context before being asked.
- **Instantly responsive & complete** — when addressed, answers now
  and carries the task to done end-to-end.

## Current session focus — 2026-05-27 (human-directed)

P0–P21 are delivered (archived in `archive/TARGETS-P0-P21.md`;
their capability ledger in `archive/CAPABILITIES-through-2026-05-27.md`).
Muse's daemons exist but live only inside the `apps/api` server,
env-gated — they do NOT run as a real background process on the
user's Mac. **This session's single theme: make the proactive /
perception daemons actually RUN on this Mac as one user-launched
process, and prove end-to-end that a notice really fires.**

Every slice is proven by a real, surface-level check (CLI smoke /
integration / `smoke:live`) driving the real code path against a
contract-faithful fake — never a stubbed registry, never a
happy-path-only assertion (`outbound-safety.md`). Proactive notices
go to the user's OWN channel (low-risk path); web-watch is
read-only — no autonomous third-party send.

## Active target

**P22 — The daemon runs for real on this Mac.** Compose the
proven-once pieces into one launchable, observable process and
prove startup→delivery end-to-end. Pick the highest undone bullet.

- [ ] **P22-1 `muse daemon` launcher.** One user-facing CLI command
  starts all configured ticks (proactive · followup · objectives ·
  ambient · web-watch) in a single shared agent-core process.
  Check: CLI smoke — the command boots, registers each ENABLED
  tick, one tick fires against a contract-faithful fake sink and
  delivers, a DISABLED tick is skipped, SIGINT shuts down cleanly.
- [ ] **P22-2 macOS active-window perception feeds the running
  daemon.** Wire `MacOsActiveWindowSource` into the launcher so a
  real OS signal drives a proactive notice on a tick. Check:
  integration — a contract-faithful osascript-source signal drives
  exactly one notice on a rule match through the real
  `ProactiveNoticeSink`; fire-once dedupe holds.
- [ ] **P22-3 Chrome connects at daemon startup + threads into
  chrome-source web-watches** (the P21 follow-on). Check:
  integration — daemon startup establishes the Chrome DevTools MCP
  connection (contract-faithful fake), a `source:"chrome"` watch
  reuses it and edge-fires; if Chrome is unavailable the daemon
  stays up and the watch fails-soft (no crash).
- [ ] **P22-4 One-shot config UX.** `muse daemon init` / `muse
  daemon status` write + validate the daemon config (provider,
  destination, ambient rules, watches) to the config path, removing
  the need to hand-set ~15 env vars; `status` shows what is enabled
  and the last tick. Check: CLI smoke round-trips a written config
  and the launcher consumes it.
- [ ] **P22-5 Full startup→delivery e2e gate.** A smoke /
  integration that starts the full daemon and proves a notice flows
  end-to-end to a contract-faithful channel fake — including that
  deny / timeout produces NO send (`outbound-safety.md`). Check:
  that smoke id, green.
- [ ] **P22-6 (only if time remains) launchd survival.** `muse
  daemon install` writes a valid LaunchAgent plist so the daemon
  survives logout/reboot. Check: the plist is generated and valid;
  load/unload dry-run succeeds.

<!-- IMMUTABLE-CORE:BEGIN -->
## Immutable core (the loop must NEVER edit — honesty machinery)

Direction is the loop's to choose. These are NOT, and exist so
autonomy can't decay into busywork:

- the north-star definition (proactive + instantly-responsive
  personal assistant; the loop never weakens it),
- the falsifiable-outward test, the banned-shapes list,
- the `CAPABILITIES.md` rules + the requirement that every goal
  ship a green surface-level (not unit-only) automated check,
- the cross-iteration falsification + 10-iter regression sweep,
- never stop / never ask a human / never complete.

A commit-msg hook (`scripts/guard-immutable.mjs`) rejects any
change to lines in this block without `[core-change: human]`.
Changing the immutable core is a human-only action.
<!-- IMMUTABLE-CORE:END -->

The loop's enforced freedom: extend/reorder targets and bullets,
never the lines between the IMMUTABLE-CORE markers.
