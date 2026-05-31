# Muse Expansion Playbook — the brief for a long `/goal` session

> Read this at the **start of every turn** of an autonomous Muse-expansion
> session (launched via `/muse-goal` + `/goal`). It is the standing contract
> for what to build and how to prove it. Keep it short; when it conflicts with
> `.claude/rules/*.md`, the rules win.

## Mission

Make Muse — a provider-neutral, JARVIS-style **personal** AI assistant — better
every turn: ship **one verified, user-facing improvement per commit**, on the
**local Ollama Qwen** tier (never a cloud API for verification). Three things
advance together: new capability, hardening what exists, and keeping the
**feature inventory** (`docs/FEATURES.md`) clean and current.

## What "done for this turn" means (verified-or-it-doesn't-exist)

Every commit must clear, before you claim it:

1. `pnpm lint` → 0 errors / 0 warnings.
2. Narrowest useful test for the touched package (`pnpm --filter @muse/<pkg> test`).
3. **Request/response-path change → a real local-Qwen round-trip.** For a
   single tool-selection proof, use the FAST check —
   `node apps/cli/scripts/verify-tool-selection.mjs "<prompt>" <tool>` (one
   `qwen3:8b` round, ~1 min, exit 0/1). Reserve the full `pnpm smoke:live`
   sweep for broad regression. **LOCAL OLLAMA QWEN ONLY** — never a cloud API;
   never the slow 35b for a single check (it stalls). If
   Ollama is down, fixing that is the turn's work.
4. **Interactive chat change → an `ink-testing-library` render test** (see
   `apps/cli/src/chat-ink-render.test.ts`) that drives the keystroke→frame path.
5. Repo byte-hygiene stays green; no `// Goal NNN` / round / iteration markers
   in source (see `.claude/rules/code-style.md`).

Surface the proof in the transcript: after each commit print the **hash**, the
**one-line outward capability** it added, and **which check went green**. No
green runnable check ⇒ the turn is not done.

## Priorities (user-directed, 2026-05)

1. **Proactive "speaks-first."** A personal assistant initiates when it helps —
   surface due reminders/follow-ups, finished background jobs, anticipations —
   idle-gated and never noisy. Deepen this (the chat already has a proactive
   poll + job-done notices; make it smarter, not chattier).
2. **CLI as a daily driver.** The Ink chat (`muse`) is where the user lives.
   Keep raising its quality: ergonomics, discoverability, transparency, speed.
3. **Agent quality: memory + performance.** Consult recent (≈2026) research and
   adopt what fits a **single-user, local-Qwen** assistant (don't import
   cloud-scale designs blindly). Concretely worth evaluating:
   - **Reflection / synthesis** over ranked-list recall — an LLM "reflect" step
     that connects facts across the memory bank, not just returns hits.
     ("Hindsight is 20/20: Retains, Recalls, Reflects", arXiv 2512.12818.)
   - **OS-style memory tiers** — core (always in context) / recall (recent) /
     archival (vector) à la Letta; Muse already has user-memory + episodes +
     last-chat — see if a tier model sharpens it.
   - **Temporal knowledge graph** — facts with validity windows that invalidate
     on contradiction (Zep): "prefers X *as of* date", supersede don't delete.
   - Survey for grounding: "Memory in the Age of AI Agents".
   Each idea ships only as a verified, local-runnable slice — never a rewrite.
4. **Actually exercise memory end-to-end.** Prove the loop on Qwen: a fact
   taught in chat (`/remember k=v`) is recalled next session (persona injection
   into the system prompt), `/memory` / `/recall` / episodes reflect reality.
   A memory feature that isn't demonstrated working on Qwen is not delivered.

## Feature doc (`docs/FEATURES.md`)

The living, planner-readable inventory of "what Muse can do today." Every
capability commit updates it: keep the status legend honest (✅ ready / ⚙️ needs
setup / ⚠️ known gap), keep sections tight, and prefer "what it does for the
user" over implementation detail. Improve its readability as you go.

## Safety (non-negotiable, from `.claude/rules/outbound-safety.md`)

Outbound-to-a-third-party (send/reply/post/submit/book) is **fail-close +
draft-first**: the user confirms exact content before anything leaves; deny /
timeout / ambiguous recipient ⇒ no effect. Banking / payments / money movement
are permanently out of scope. Ship a "send/act" capability only with a test
proving the deny path produces no external effect.

## Tooling reminders

- One slice inline; spawn sub-agents only for genuinely independent parallel
  work (e.g. a multi-file audit), per `.claude/rules/iteration-loop.md`.
- `pnpm deadcode` (knip) checks unused files/deps; treat its "unused exports"
  as low-confidence (re-export false positives).
- Local model picks the right tool in ONE shot — keep tool sets small + names
  unambiguous (`.claude/rules/tool-calling.md`).

## The goal condition to run

Paste this into `/goal` (or run `/muse-goal`, which sets it up):

> Follow docs/EXPANSION-PLAYBOOK.md. Each turn, ship exactly ONE verified Muse
> improvement as a small commit — a new user-facing capability, a hardening of
> an existing one, a proactive/CLI/memory/performance upgrade, or a
> docs/FEATURES.md consolidation — with its acceptance check green: `pnpm lint`
> 0/0, the narrowest touched-package test, and `pnpm smoke:live` on local Ollama
> Qwen for any request/response change (interactive-chat changes get an
> ink-testing-library render test instead). After each commit, state the commit
> hash, the one-line outward capability it added, and which check passed. Never
> claim a turn done without a green runnable check; never perform an autonomous
> outbound send (outbound stays fail-close + draft-first). Keep going until at
> least 12 such verified commits have landed OR ~6 hours / 60 turns have
> elapsed, whichever first; then summarize everything that shipped and stop.
