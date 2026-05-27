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

**P26 — Widen the daemon's perception reach.** `muse daemon` runs the
proactive/followup/ambient/web-watch/objectives ticks; bring the
remaining proven perception sources into the same one-process launcher
so the user's resident Muse perceives more of their world.

- [x] **P26-1 Home Assistant entity-state watch in the launcher.** The
  daemon runs a read-only home-watch tick (HA entity states via
  `homeWatchesFromConfig`, same `createWebWatchRunner` + sink), active
  with `MUSE_HOME_WATCH_CONFIG` + HA creds. A watched entity reaching a
  rule state (e.g. door "unlocked") fires a notice; never acts on the
  home (outbound-safety). Proven by a contract-faithful CLI smoke (a HA
  `/api/states` snapshot fires the notice; skipped without config) and
  surfaced in `--status` — `apps/cli/src/commands-daemon.test.ts`.
- [x] **P26-2 Due-reminders tick in the launcher.** The daemon fires
  due reminders (`runDueReminders`, always-on like proactive — no model
  needed) so the resident process covers the full proactive set
  (proactive · reminders · followup · ambient · web-watch · objectives ·
  home-watch = 7 ticks). Proven: a due pending reminder is delivered to
  a contract-faithful sink, a future one isn't; reported by `--status`
  — `apps/cli/src/commands-daemon.test.ts`.

## Delivered — P25 (ambient context fusion: Perception × Knowledge)

Ambient notices carry a "Related:" line from the user's real notes
about the active window. Audited PASS (README ledger, `P25 audit`).

- [x] **P25-1 Ambient notices carry a "Related:" line.** The daemon's
  ambient runner accepts a knowledge enricher; a fired ambient notice
  is enriched with a `— Related: …` line keyed on the active
  window/app. Proven by a contract-faithful CLI smoke: an injected
  enricher's line rides the delivered ambient notice; absent → plain
  notice — `apps/cli/src/commands-daemon.test.ts`.
- [x] **P25-2 Real enricher from the user's corpus.** The daemon builds
  the ambient enricher best-effort at startup from
  `createKnowledgeEnricher` (notes dir + local Ollama embed,
  hybrid+MMR) when `MUSE_BRIEFING_RELATED_KNOWLEDGE_ENABLED`; fail-soft
  to plain notices otherwise. Live-verified: over a temp notes dir,
  `enrich("Q3 budget memo")` returned the real `notes/q3-budget.md`
  line (not the parking decoy) — the daemon's exact builder. Seam +
  default-off tested in `apps/cli/src/commands-daemon.test.ts`.

## Delivered — P24 (Knowledge grounding quality: MMR)

Diversified knowledge_search top-K with MMR (best-effort on real
paraphrases; deterministic on exact duplicates). Audited PASS
(README ledger, `P24 audit`).

- [x] **P24-1 MMR diversification.** `rankKnowledgeChunks` gains an
  opt-in `diversify` path applying Maximal Marginal Relevance
  (Carbonell & Goldstein, SIGIR 1998) over the ranked candidates —
  `λ·relevance − (1−λ)·max-similarity-to-picked` — so a near-duplicate
  passage doesn't crowd out a distinct relevant one. Both
  `knowledge_search` surfaces use it. Proven: plain top-2 returns two
  near-duplicates; MMR returns one duplicate + the distinct passage —
  `packages/agent-core/test/knowledge-recall-agent.test.ts`. No dep,
  deterministic, local.
- [x] **P24-2 Tune/verify MMR on the real corpus (live).** Live
  nomic-embed measurement on a real near-duplicate corpus: λ=0.7 never
  dropped a paraphrase (both surfaced), so the default is lowered to
  **0.5**. Honest finding: even at 0.5 the dedup of real paraphrases is
  marginal — embedding jitter flips the thin MMR margin run-to-run — so
  MMR is kept as a best-effort diversity NUDGE, deterministically
  proven only on exact duplicates (`knowledge-recall-agent.test.ts`),
  not a guaranteed live paraphrase-dedup. No over-claim.

## Delivered — P23 (deepen Knowledge retrieval: hybrid RRF)

Cosine RAG fused with lexical keyword overlap via RRF across the
agent tool + corpus-search surfaces, recalling exact rare tokens the
embedding misses. Audited PASS (README ledger, `P23 audit`).

- [x] **P23-1 Hybrid (RRF) knowledge retrieval.** `rankKnowledgeChunks`
  gains an opt-in `hybrid` path fusing the cosine ranking with a
  lexical keyword-overlap ranking via Reciprocal Rank Fusion (Cormack,
  Clarke & Büttcher, SIGIR 2009); `knowledge_search` now uses it, so an
  exact rare token the embedding misses is still recalled. Proven: a
  corpus whose exact-keyword chunk has zero cosine is dropped by pure
  cosine but recalled by hybrid — `packages/agent-core/test/knowledge-recall-agent.test.ts`.
  No new dep, deterministic, local.
- [x] **P23-2 Hybrid in the corpus-search callers.** The
  `knowledge-corpus.ts` search paths — the situational-briefing
  `createKnowledgeEnricher` and the `createNotesKnowledgeSearchTool`
  corpus search — now rank via the hybrid path too. A zero-cosine
  exact-keyword chunk is recalled by the corpus-search tool; the
  lexical scorer drops stopwords so a decoy sharing only "my"/"is" is
  NOT falsely recalled — `packages/autoconfigure/test/knowledge-recall-sources.test.ts`.

## Delivered — P22 (the daemon runs for real on this Mac)

Composed the proven-once pieces into one launchable, observable
process and proved startup→delivery end-to-end. Audited PASS
(README ledger, `P22 audit`).

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
- [x] **P22-1f SIGINT clean-shutdown smoke.** The `muse daemon`
  foreground loop now stops cleanly on SIGINT/SIGTERM via
  `DaemonStopSignal` (interruptible sleep — ctrl-c exits at once, no
  waiting out the interval; survives a throwing tick; no `process.exit`)
  — `runDaemonLoop` suite in `apps/cli/src/commands-daemon.test.ts`.
  **P22-1 (the launcher) is complete: all five ticks + clean shutdown.**
- [x] **P22-2 macOS active-window perception feeds the running
  daemon.** `muse daemon` now selects `MacOsActiveWindowSource` for
  its ambient tick when `MUSE_AMBIENT_SOURCE=macos` (darwin, or
  whenever a test injects the osascript runner). A contract-faithful
  osascript signal (`"Slack\ngeneral"`) drives exactly one notice on a
  matching rule through the real sink — see
  `apps/cli/src/commands-daemon.test.ts`.
- [x] **P22-3a chrome-source web-watch threading.** `muse daemon`
  threads a `ChromeSnapshotConnection` into `webWatchesFromConfig`, so
  a `source:"chrome"` watch reuses it and edge-fires; with NO
  connection the chrome watch is skipped fail-soft and the daemon
  stays up. Proven by a contract-faithful fake connection — see
  `apps/cli/src/commands-daemon.test.ts`.
- [x] **P22-3b real Chrome connection at daemon startup.** When
  `MUSE_CHROME_DEVTOOLS_ENABLED`, `muse daemon` builds the connection
  from the runtime assembly's `McpManager` (connect chrome-devtools →
  adapt `toMuseTools()` into a `ChromeSnapshotConnection` via
  `chromeSnapshotConnectionFromTools`), best-effort + fail-soft
  (disabled / connect-refused → `undefined` → chrome watches skip,
  daemon stays up). The adapter is contract-faithfully tested
  (adapts tools → drives a daemon chrome-watch edge-fire e2e); the
  literal browser handshake is verified manually, not in CI — see
  `apps/cli/src/commands-daemon.test.ts`.
- [x] **P22-4a `muse daemon --status` readiness report.** Prints which
  of the five ticks are enabled for the current config (proactive
  always; followup/objectives on a resolved model; ambient on
  `MUSE_AMBIENT_RULES`; web-watch on `MUSE_WEB_WATCH_CONFIG`) and
  exits without ticking — see `apps/cli/src/commands-daemon.test.ts`.
- [x] **P22-4b `muse daemon --init` config file.** Writes the resolved
  provider + destination to `~/.config/muse/daemon.json`
  (`MUSE_DAEMON_CONFIG_FILE` override); the launcher loads it with
  precedence flag > env > config > default, so the user persists them
  once instead of exporting env vars. Round-tripped by a CLI smoke
  (init writes → a later run with no flag/env reads + delivers) — see
  `apps/cli/src/commands-daemon.test.ts`. (Ambient-rules/watches in the
  config file remain a follow-on; provider/destination are the core.)
- [x] **P22-5 Full startup→delivery e2e gate.** A CLI smoke runs the
  full daemon with ALL five ticks enabled in one `--once` and proves
  each delivers to a contract-faithful sink (5 sends); a separate
  smoke proves a denied / timed-out provider send yields ZERO delivery
  (not marked fired — sidecar unpoisoned, history "failed"), the
  daemon stays up, no phantom send (`outbound-safety.md`) — see
  `apps/cli/src/commands-daemon.test.ts`.
- [x] **P22-6 launchd survival.** `muse daemon --install` writes a
  macOS LaunchAgent plist (`~/Library/LaunchAgents/com.muse.daemon.plist`,
  `MUSE_DAEMON_PLIST_FILE` override) with `RunAtLoad` + `KeepAlive` so
  the daemon survives logout/reboot, and prints the `launchctl load -w`
  line. The generated plist passes `plutil -lint` (the OS's own
  validator) — see `apps/cli/src/commands-daemon.test.ts`.

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
