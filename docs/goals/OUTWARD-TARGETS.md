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
user's Mac. **This session pursues two sanctioned directions, the
loop choosing the highest-value one per iteration: (A) make the
proactive / perception daemons actually RUN on this Mac as one
user-launched process and prove end-to-end a notice really fires
(target P22); (B) apply good capabilities from freely-usable open
research under the guardrails below.**

Every slice is proven by a real, surface-level check (CLI smoke /
integration / `smoke:live`) driving the real code path against a
contract-faithful fake — never a stubbed registry, never a
happy-path-only assertion (`outbound-safety.md`). Proactive notices
go to the user's OWN channel (low-risk path); web-watch is
read-only — no autonomous third-party send.

## Applying open research (human-directed 2026-05-28)

The loop MAY adopt a capability from a paper when ALL hold; when in
doubt, SKIP:

- **Freely usable.** The paper is openly readable AND nothing
  restricts implementing its idea — open method, no patent / licence
  bar on use. A restricted or patent-encumbered technique is out.
- **Local-first.** No new paid dependency, no cloud API key; runs on
  the local Qwen / Ollama; deterministic where it can be.
- **Cited in the CODE.** A one-line WHY comment names the paper + id
  at the implementation site (e.g.
  `// importance-modulated decay (FadeMem, arXiv 2601.18642)`) — an
  allowed WHY comment per `code-style.md` — AND the `CAPABILITIES.md`
  line names it too.
- **Verified, effect measured.** Ships as a normal slice with a
  green surface-level check; where feasible the check MEASURES the
  paper's claimed effect, not just that the code runs. A research
  idea with no runnable check is not delivered.

Sizing (both directions): a slice too large for one ~10-min commit
is DECOMPOSED across iterations — one end-to-end vertical increment
each, per `iteration-loop.md`. Never crammed into one oversized
turn; never half-shipped.

## Active target

**P22 — The daemon runs for real on this Mac.** Compose the
proven-once pieces into one launchable, observable process and
prove startup→delivery end-to-end. Pick the highest undone bullet.

- [x] **P22-1a `muse daemon --once` proactive seam.** A user-facing
  CLI command launches the proactive tick in one process and returns
  after a single tick (the testable launcher seam, no infinite loop).
  Delivered + verified by a contract-faithful CLI smoke: an imminent
  task is delivered to a capturing messaging sink, a quiet tick sends
  nothing, an unknown provider fails closed (no send) — see
  `apps/cli/src/commands-daemon.test.ts`.
- [x] **P22-1b followup tick folded into the launcher.** `muse daemon
  --once` now runs the proactive AND followup ticks in one process; a
  DUE followup is synthesized + delivered to a contract-faithful sink
  (proactive-only cases stay hermetic; followups skip cleanly when no
  model resolves) — see `apps/cli/src/commands-daemon.test.ts`.
- [x] **P22-1c ambient tick folded into the launcher.** `muse daemon
  --once` now also runs the rule-based ambient perception tick; a
  matching ambient rule delivers a notice to a contract-faithful sink
  (skipped cleanly when no `MUSE_AMBIENT_RULES` configured) — see
  `apps/cli/src/commands-daemon.test.ts`.
- [x] **P22-1d web-watch tick folded into the launcher.** `muse daemon
  --once` now also runs read-only web-watch polling; an "appears"
  trigger over an injected fetch delivers a notice to a
  contract-faithful sink (skipped cleanly when no
  `MUSE_WEB_WATCH_CONFIG`) — see `apps/cli/src/commands-daemon.test.ts`.
- [x] **P22-1e objectives tick folded into the launcher.** `muse daemon
  --once` now also re-evaluates standing objectives and notifies on
  "met" — all FIVE ticks (proactive + followup + ambient + web-watch +
  objectives) run in one process. A MET objective notifies via a
  contract-faithful sink (skipped cleanly when no model) — see
  `apps/cli/src/commands-daemon.test.ts`.
- [ ] **P22-1f SIGINT clean-shutdown smoke.** Prove the `muse daemon`
  foreground loop stops cleanly on a stop signal (runs N ticks then
  exits 0, no orphaned timer). Check: CLI smoke over an injectable
  sleep + stop seam. This closes P22-1 (the launcher).
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
