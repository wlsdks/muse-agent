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
`AuthoredSkillStore.recordUsage()` and the `muse skills authored` command
(`packages/skills/src/authored-skill-store.ts`, `apps/cli/src/commands-skills.ts`).

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
ecosystems. Patterns flagged for future Muse slices: sleep/"dreaming" memory
consolidation (short→long promotion with a weighted score), the correction→
pending-skill *skill-workshop* pipeline (security-scan + approval gate), and
open-loop / commitment extraction for proactive follow-up.

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
