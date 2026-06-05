# Third-Party Notices

This file has two parts:

1. **Bundled / linked dependencies** — real third-party code and model weights
   that ship with or are downloaded by Muse (currently: the macOS desktop
   companion's on-device voice). Their licenses travel with the distribution
   and are reproduced/attributed below.
2. **Studied patterns** — design ideas reimplemented from scratch in Muse's own
   TypeScript codebase, with **no** third-party source copied or vendored.
   Attributed in the spirit of their (MIT) licenses, for transparency.

---

# Part 1 — Bundled / linked dependencies

## Argmax Open-Source SDK — WhisperKit / TTSKit / SpeakerKit (MIT)

- Project: https://github.com/argmaxinc/argmax-oss-swift
- License: MIT, Copyright (c) 2024–2026 Argmax, Inc.
- **How Muse uses it:** the macOS desktop companion (`apps/desktop`) links these
  Swift packages via SwiftPM. **WhisperKit** powers on-device speech-to-text
  (Whisper on CoreML + the Apple Neural Engine, native streaming); **TTSKit**
  powers on-device text-to-speech (Qwen3-TTS). Everything runs locally — audio
  never leaves the Mac. The package vendors HuggingFace `swift-transformers`
  (Hub + Tokenizers) under its original Apache-2.0 license.

```
MIT License

Copyright (c) 2024 Argmax, Inc.

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

## Qwen3-TTS model weights — Alibaba Cloud / Qwen team (Apache-2.0)

- Project: https://github.com/QwenLM/Qwen3-TTS
- License: Apache License 2.0, Copyright (c) Alibaba Cloud (Qwen team)
- **How Muse uses it:** the desktop companion's spoken replies are synthesized
  by the Qwen3-TTS model, run on-device through TTSKit. The CoreML weights
  (`qwen3-tts` 0.6b) are downloaded once from HuggingFace and cached locally;
  they are not redistributed in the Muse repo. Apache-2.0 permits commercial
  use, modification, and redistribution; the license and any NOTICE file from
  the upstream model must be retained with redistributed weights. Full text:
  https://www.apache.org/licenses/LICENSE-2.0

## Whisper `large-v3-v20240930` CoreML weights — via Argmax (MIT) / OpenAI Whisper (MIT)

- Source: https://huggingface.co/argmaxinc/whisperkit-coreml
- **How Muse uses it:** WhisperKit downloads the CoreML-converted Whisper model
  for speech-to-text once from HuggingFace and caches it locally (not vendored
  in the repo). The underlying OpenAI Whisper model is MIT-licensed; the CoreML
  conversions are distributed by Argmax (MIT).

---

# Part 2 — Studied patterns (reimplemented, no source copied)

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

---

## SkillOpt — Microsoft Research (MIT)

- Project: https://github.com/microsoft/SkillOpt (paper: arXiv 2605.23904)
- License: MIT, Copyright (c) 2026 Microsoft Corporation

**What Muse learned from it (pattern, not code):** the *propose-and-test*
discipline for self-improving skills — treat reflection as a proposed edit that
is **accepted only when it passes a held-out validation gate**, never an
unconditional self-edit. Muse applies this to the curator skill-merge: a
proposed umbrella commits only if it still semantically covers every clustered
skill, else it is rejected and rolled back (originals untouched). Reimplemented
as Muse's `validateUmbrellaCoverage`
(`packages/agent-core/src/skill-merge-gate.ts`), wired into
`AuthoredSkillStore.consolidate` and the idle curator daemon
(`apps/api/src/consolidate-tick.ts`) — local nomic-embed coverage check,
fail-closed when the embedder is unavailable, no code copied. SkillOpt's
bounded-edit "textual learning rate" and rejected-edit feedback buffer are
patterns flagged for future Muse slices (the same gate over playbook / preference
/ reflection self-edits).

```
MIT License

Copyright (c) 2026 Microsoft Corporation

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
