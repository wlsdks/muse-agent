# Third-Party Notices

Muse is an independent project. The components below were **studied for their
design patterns** and reimplemented from scratch in Muse's own TypeScript
codebase — no third-party source code is copied or vendored. We record the
attributions here anyway, in the spirit of the MIT License under which these
projects are published, and to be transparent about where ideas came from.

If a future change ever copies or adapts substantial source from any of these
projects, the corresponding MIT copyright notice below must travel with that
code (in-file and in this document).

---

## Hermes Agent — Nous Research (MIT)

- Project: https://github.com/NousResearch/hermes-agent
- License: MIT, Copyright (c) 2025 Nous Research

**What Muse learned from it (pattern, not code):** the *fork-and-review*
self-improvement loop — after a turn/session the assistant reviews what just
happened and decides what to persist, with skill authoring kept separate from
the user-facing turn. Muse's session-end skill-authoring review
(`packages/agent-core/src/skill-review.ts`, `apps/cli/src/chat-author-skills.ts`)
and its "prefer a procedure → skill, a preference → playbook" split are inspired
by this design. Hermes' progressive-disclosure skill catalog also informed
Muse's pre-existing `chat-skills.ts` exposure.

Additionally, Hermes' *curator* lifecycle — tracking `lastUsedAt` on
agent-created skills to eventually archive stale ones — informed Muse's
`AuthoredSkillStore.recordUsage()`/`.curate()` and the `muse skills authored`
/ `muse skills curate` commands
(`packages/skills/src/authored-skill-store.ts`, `apps/cli/src/commands-skills.ts`).
Hermes' Honcho dialectic user model (a peer card that accrues over observed
conversation) informed Muse's typed UserModel accrual — `muse user model`
slots + behavior-inferred preferences (`packages/agent-core/src/preference-inference.ts`,
`apps/cli/src/commands-user.ts`) — reimplemented deterministically, no code copied.
Hermes' curator *umbrella consolidation* (folding narrow agent-created skills
into class-level umbrellas) informed Muse's `mergeSkillsIntoUmbrella` /
`AuthoredSkillStore.consolidate` / `muse skills consolidate`
(`packages/agent-core/src/skill-merge.ts`, `packages/skills/src/authored-skill-store.ts`)
— one local-model merge with archive-never-delete, no code copied.
Finally, Hermes' `agent/background_review.py` — delivering the answer THEN
running a separate review gated by TWO triggers (turn-count → memory,
tool-iteration-count → skills, so "hard tasks teach") — is the idea behind
Muse's background-review engine (`packages/agent-core/src/background-review.ts`):
reimplemented on Muse's own `HookStage` seam (`afterTool` counts iterations,
`afterComplete` fires the review fire-and-forget), orchestrating Muse's existing
deterministic distillers, no Hermes code copied.

```
MIT License

Copyright (c) 2025 Nous Research

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## OpenClaw — OpenClaw Foundation (MIT)

- License: MIT, Copyright (c) 2026 OpenClaw Foundation

**What Muse learned from it (pattern, not code):** the SKILL.md skill format
(frontmatter + markdown body) — Muse's `@muse/skills` contract already mirrors
the OpenClaw / Anthropic field names so authors can lift a SKILL.md between
ecosystems. The memory-consolidation idea (surfacing what recurs across
sessions rather than recalling a single one) informed Muse's deterministic
`recurringThemes()` / `muse episode themes`
(`packages/mcp/src/personal-episodes-store.ts`). Patterns flagged for future
Muse slices: the rest of sleep/"dreaming" memory consolidation — its
near-duplicate-episode consolidation informed Muse's deterministic
`planEpisodeConsolidation()` / `muse episode consolidate`
(`packages/mcp/src/personal-episodes-store.ts`); short→long promotion with a
weighted score is still future. Its *skill-workshop* scan-before-activate
idea informed Muse's deterministic `scanSkillBodyForRisks()` — auto-authored
skill bodies flagged for prompt-injection / dangerous-shell / embedded-secrets
are quarantined instead of activated
(`packages/skills/src/authored-skill-store.ts`). Its open-loop /
commitment-extraction idea informed Muse's deterministic
`detectUserCommitments()` / `muse commitments scan`
(`packages/agent-core/src/commitment-detector.ts`).

```
MIT License

Copyright (c) 2026 OpenClaw Foundation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
