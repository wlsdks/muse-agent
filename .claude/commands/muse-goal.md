---
description: Launch a long autonomous Muse-expansion session (reads the playbook, then runs under /goal)
argument-hint: [optional focus, e.g. "memory" or "proactive" or "cli"]
---

You are starting a **long autonomous Muse-expansion session** (target ~6 hours).

1. Read `docs/EXPANSION-PLAYBOOK.md` in full and treat it as your standing
   contract for this session — mission, the verified-or-it-doesn't-exist bar,
   the priorities (proactive · CLI · memory+performance · prove memory on Qwen),
   feature-doc upkeep, and the outbound-safety guardrails.
2. Also honor `.claude/rules/*.md` (iteration-loop, outbound-safety,
   tool-calling, testing, code-style, commits) — they override the playbook on
   conflict.
3. Optional focus for this session: **$ARGUMENTS** — if given, bias slice
   selection toward it; if empty, pick the highest-value bullet yourself
   (proactive / CLI / memory / performance), newest-relevant 2026 research
   considered but adopted only where it fits a local single-user Qwen assistant.

Work the loop: pick one outward slice → implement → verify on **local Ollama
Qwen** (`pnpm smoke:live`) and/or render tests + `pnpm lint` 0/0 → small commit
→ update `docs/FEATURES.md` → state the commit hash + the one new user-facing
capability + which check passed → repeat. Never claim a turn done without a
green runnable check. Never perform an autonomous outbound send.

**To run unattended**, set the completion condition now with `/goal` using the
"goal condition to run" block at the bottom of `docs/EXPANSION-PLAYBOOK.md`
(≥12 verified commits OR ~6h/60 turns, then summarize and stop). Confirm Ollama
is reachable first (`curl -s localhost:11434/api/tags`); if it isn't, getting it
back up is the first slice.
