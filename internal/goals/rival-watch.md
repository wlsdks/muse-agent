# Rival watch — scout-rivals ledger

> Maintained by the `scout-rivals` skill. The exhaustive BASE is the
> 2026-06-23 teardown (`competitor-teardown.md`, 231 judged items in
> `growth-backlog.md` / `judgment-lens.md`) — this
> file tracks only what the world did AFTER that, one watermark bump per
> scout. Delta findings land in the parity backlog (`[scout YYYY-MM-DD]`
> tag) or as `→improve-muse` ◦ lines in backlog.md; this file stays thin.

## Watermark

- **last scout:** 2026-07-17 15:39 (fire 2)
- **base:** 2026-06-23 exhaustive teardown (do not re-scout — delta only)
- **local clones (persistent, owner-designated 2026-07-17):** `$HOME/ai/<name>` —
  fetch, never re-clone (`git -C $HOME/ai/<name> fetch origin`).
- **roster:**
  - openclaw — https://github.com/openclaw/openclaw — MIT (LICENSE text verified; GitHub misreports NOASSERTION) — clone `$HOME/ai/openclaw` — SHA 9ac2f7748 (2026-07-17 fire 2, 383k★)
  - hermes-agent (Nous) — https://github.com/NousResearch/hermes-agent — MIT — clone `$HOME/ai/hermes-agent` — SHA 779019ef7 (2026-07-17 fire 2, 216k★)
  - QwenPaw — https://github.com/agentscope-ai/QwenPaw — Apache-2.0 — clone `$HOME/ai/QwenPaw` (blobless) — SHA 765aef85 (2026-07-17; 23k★/5mo, v2.0.0 2026-07-10; enrolled this scout, code spot-checked: ReMe memory + console + e2e)
- **queries run last scout:** "new open source personal AI assistant July 2026 local-first"; "personal assistant agent open source 2026 alternative openclaw hermes"

## Reference shelf (cloned, consulted on demand — NOT delta-watched per fire)

> Famous open-source personal-agent codebases kept at `$HOME/ai/<name>`
> for mechanism lookups (memory, continuity, voice). Fetch with the roster at
> fire start; promote to the roster only when one meets the enrollment bar.
> **License rule (all roster+shelf): reference-only, NO verbatim copy —
> reimplement with attribution.**
> 🚨 **AGPL repos (khoj): IDEAS ONLY, ZERO code. Not one line, not one
> comment, not one identifier name gets carried over — read it, close it, and rewrite it in your own design.
> Violation = the slice fails review, no exceptions (owner directive
> 2026-07-17).**

- khoj — https://github.com/khoj-ai/khoj — 🚨 **AGPL-3.0 — extreme caution. Not one line of
  code, not a comment, not a schema/prompt phrase gets copied. Read for ideas only → reimplement
  entirely in your own words. Carrying over even one line puts all of Muse under network
  copyleft obligations. If a diff shows a khoj-derived string, that slice is FAIL.** — `$HOME/ai/khoj` (36k★, personal
  second brain / doc+web memory)
- letta — https://github.com/letta-ai/letta — Apache-2.0 — `$HOME/ai/letta` (24k★, MemGPT-lineage stateful memory)
- leon — https://github.com/leon-ai/leon — MIT — `$HOME/ai/leon` (17k★, local personal assistant since 2019)

## Roster changes

- 2026-07-17 ENROLLED QwenPaw (evidence: 23k stars in ~5 months, v2.0.0 released in-window 7/10 + 2 patch releases, code spot-check ✓). Deep delta pass pending next scout (this fire recorded enrollment + headline: AgentScope 2.0 Agent-OS rewrite, ReMe v0.4 long-term memory).
- 2026-07-17 NOT enrolled: Leon 2.0 (long-established, low velocity vs roster bar), Vellum (hosted-first product, listicle-promoted), MemGPT-class hype posts (no code verified).

## Scout log

- 2026-07-17 15:39 · fire 2 (same-day re-fire, window = fire 1 SHAs → now): 11 commits total (openclaw 4: fixes/CI · hermes 5: Codex commentary streaming — coding-engine channel, lens-out · QwenPaw 2: version bump + bounded summary history) — **no material delta**; watermark bumped, nothing fed. Honest-empty outcome per guardrail.
- 2026-07-17 · first delta fire (window 6/23→7/17: openclaw 7,828 commits/9 releases, hermes 3,297 commits/3 releases — high-velocity: swept via releases+CHANGELOG, not raw log) · fed: BKP-1(build★5), OBS-LOG-1(maybe⏳), GOAL-CT-1(⚠), JRN-2(maybe) → parity §22; 2 ◦ hardening lines → backlog (config-plane egress audit, install provenance ack) · skipped w/ reason: MoA-first-class(matches existing MoA verdict — local single-model identity), scale-to-zero/drain·hosted workspace(multi-tenant), Vertex AI(cloud org), desktop coding Projects(coding-agent territory), GPT-5.6 defaults(cloud).
