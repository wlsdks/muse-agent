# Rival watch — scout-rivals ledger

> Maintained by the `scout-rivals` skill. The exhaustive BASE is the
> 2026-06-23 teardown (`competitor-teardown.md`, 231 judged items in
> `capability-parity-backlog.md` / `capability-parity-judgment.md`) — this
> file tracks only what the world did AFTER that, one watermark bump per
> scout. Delta findings land in the parity backlog (`[scout YYYY-MM-DD]`
> tag) or as `→improve-muse` ◦ lines in backlog.md; this file stays thin.

## Watermark

- **last scout:** 2026-07-17
- **base:** 2026-06-23 exhaustive teardown (재스카웃 금지 — delta only)
- **local clones (persistent, owner-designated 2026-07-17):** `/Users/jinan/ai/<name>` —
  fetch, never re-clone (`git -C /Users/jinan/ai/<name> fetch origin`).
- **roster:**
  - openclaw — https://github.com/openclaw/openclaw — MIT (LICENSE text verified; GitHub misreports NOASSERTION) — clone `/Users/jinan/ai/openclaw` — SHA 8fa4867ab (2026-07-17, 383k★)
  - hermes-agent (Nous) — https://github.com/NousResearch/hermes-agent — MIT — clone `/Users/jinan/ai/hermes-agent` — SHA 73ad9136 (2026-07-17, 216k★)
  - QwenPaw — https://github.com/agentscope-ai/QwenPaw — Apache-2.0 — clone `/Users/jinan/ai/QwenPaw` (blobless) — SHA cc179603 (2026-07-17; 23k★/5mo, v2.0.0 2026-07-10; enrolled this scout, code spot-checked: ReMe memory + console + e2e)
- **queries run last scout:** "new open source personal AI assistant July 2026 local-first"; "personal assistant agent open source 2026 alternative openclaw hermes"

## Reference shelf (cloned, consulted on demand — NOT delta-watched per fire)

> Famous open-source personal-agent codebases kept at `/Users/jinan/ai/<name>`
> for mechanism lookups (memory, continuity, voice). Fetch with the roster at
> fire start; promote to the roster only when one meets the enrollment bar.
> **License rule (all roster+shelf): reference-only, NO verbatim copy —
> reimplement with attribution.**
> 🚨 **AGPL repos (khoj): IDEAS ONLY, ZERO code. 한 줄도, 주석 한 줄도,
> 식별자 이름 하나도 옮기지 않는다 — 읽고 덮고, 자기 설계로 다시 쓴다.
> Violation = the slice fails review, no exceptions (owner directive
> 2026-07-17).**

- khoj — https://github.com/khoj-ai/khoj — 🚨 **AGPL-3.0 — 절대 주의. 코드를 단 한 줄도,
  주석도, 스키마·프롬프트 문구도 베끼지 않는다. 읽고 아이디어만 참조 → 완전히 자기 말로
  재구현. 한 줄이라도 옮기면 Muse 전체가 네트워크 카피레프트 의무에 걸린다. diff에 khoj
  유래 문자열이 보이면 그 슬라이스는 FAIL이다.** — `/Users/jinan/ai/khoj` (36k★, personal
  second brain / doc+web memory)
- letta — https://github.com/letta-ai/letta — Apache-2.0 — `/Users/jinan/ai/letta` (24k★, MemGPT-lineage stateful memory)
- leon — https://github.com/leon-ai/leon — MIT — `/Users/jinan/ai/leon` (17k★, local personal assistant since 2019)

## Roster changes

- 2026-07-17 ENROLLED QwenPaw (evidence: 23k stars in ~5 months, v2.0.0 released in-window 7/10 + 2 patch releases, code spot-check ✓). Deep delta pass pending next scout (this fire recorded enrollment + headline: AgentScope 2.0 Agent-OS rewrite, ReMe v0.4 long-term memory).
- 2026-07-17 NOT enrolled: Leon 2.0 (long-established, low velocity vs roster bar), Vellum (hosted-first product, listicle-promoted), MemGPT-class hype posts (no code verified).

## Scout log

- 2026-07-17 · first delta fire (window 6/23→7/17: openclaw 7,828 commits/9 releases, hermes 3,297 commits/3 releases — high-velocity: swept via releases+CHANGELOG, not raw log) · fed: BKP-1(build★5), OBS-LOG-1(maybe⏳), GOAL-CT-1(⚠), JRN-2(maybe) → parity §22; 2 ◦ hardening lines → backlog (config-plane egress audit, install provenance ack) · skipped w/ reason: MoA-first-class(기존 MoA 판정 정신 — 로컬 단일모델 정체성), scale-to-zero/drain·hosted workspace(멀티테넌트), Vertex AI(cloud org), desktop coding Projects(코딩 에이전트 영역), GPT-5.6 defaults(cloud).
