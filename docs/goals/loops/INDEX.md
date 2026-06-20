# Loop index — all autonomous loops at a glance

> Thin aggregator (loop-creator v1.14.0+). One line per loop. Each loop updates ONLY its own row on
> commit, so this never becomes a contended append point. Detail lives in each loop's journal.
> Convention: [README](README.md).

| slug | theme | journal | last fire | last commit | skill | status |
|---|---|---|---|---|---|---|
| `tool-hardening` | TOOL expansion & hardening (main worktree) | [tool-hardening.md](tool-hardening.md) | 148 | `177a6c9b` | v1.14.0 | active (cron, session-only) |
| `cognition` | agent-core 인지 강화 (worktree `agent-core-enhance`) | [cognition.md](cognition.md) | 39 | — | — | superseded → re-registered as `agent-core-cognition` (v1.14.0, cron 42e5d7ba) |
| `agent-core-cognition` | agent-core 인지 코어 강화 (worktree `agent-core-enhance`) | [agent-core-cognition.md](agent-core-cognition.md) | 63 | `dad16a57` | v1.14.0 | STOPPED fire 63 (Jinan directive; cron 42e5d7ba deleted) |
| `differentiation` | 경쟁 차별점 발굴 → edge 확장 vs hermes/openclaw (worktree `/tmp/muse-differentiation`) | [differentiation.md](differentiation.md) | 16 | `1f4b4b1d` | v1.14.0 | active (cron `291e935d`, session-only) |
| `codebase-quality` | 코드베이스 내부 품질 (decompose/cohere/dead-code/주석 · @muse/recall 추출) (worktree `codebase-quality`) | [codebase-quality.md](codebase-quality.md) | 106 | `f7822368` | v1.14.0 | active (cron `725247c7`, session-only) |
| `tool-mcp-browser` | TOOL 확장+하드닝 · 공식 공개 외부 MCP(Notion/GitHub) · muse-in-chrome (worktree `tool-mcp-browser`) | [tool-mcp-browser.md](tool-mcp-browser.md) | 23 | (fire 23 STOP/exhaustion) | v1.14.0 | active (cron `d410848c`, session-only) |
| `grounding-integrity` | grounded≠true ceiling + self-improvement reliability + self-judge meta-eval (worktree `grounding-integrity`) | [grounding-integrity.md](grounding-integrity.md) | 29 | `962d4778` | v1.14.0 | active (cron `8ed88aa8`, session-only) |
| `surfaces` | 제품 표면 강화 — CLI · macOS desktop · web (worktree `/tmp/muse-surfaces`, branch `loop/surfaces`) | [surfaces.md](surfaces.md) | 56 | `4f4894e7` | v2.0.0 | active (manual this session; cron `c5b90c94` deleted — raced same worktree) |
| `test-hygiene` | 테스트 스위트 위생 — 저가치/중복 제거 + 누락 고가치 추가 + flaky 수정 (mutation-first) (worktree `test-hygiene`) | [test-hygiene.md](test-hygiene.md) | 52 | `c249c6d2` | v1.14.0 | active (cron `b7a92bf5`, session-only) |
| `context-strategy` | Context engineering — leanest sufficient context per turn (worktree `/tmp/muse-context-strategy`, branch `loop/context-strategy`) | [context-strategy.md](context-strategy.md) | 5 | `f873af9c` | v2.0.0 | active (cron `c66c8b81`, session-only, Tier2 push+PR, merge-to-main every 5 fires) |
| `core-hardening` | Muse 코어 엣지 강화 — grounding+citation 게이트 + 4 표면 (worktree `/tmp/muse-core-hardening`, branch `loop/core-hardening`, Tier2 push) | [core-hardening.md](core-hardening.md) | 9 | `0a6db466` | v2.0 | active (cron `d8c31fa3`, session-only) |
| `paper-grounded` | 논문-근거 차별화 기능 강화 — grounding/citation 게이트 · RGV verifier · Playbook · whetstone (worktree `/tmp/muse-paper-grounded`, branch `loop/paper-grounded-features`, Tier2 push) | [paper-grounded.md](paper-grounded.md) | 3 | `1ee899bf` | v2.0.0 | STOPPED fire 3 (Jinan: superseded by `core-hardening`, same theme; cron `ab8e4a5f` deleted. fires 1-2 verified work landed on main) |
| `self-improvement` | hermes-style 자기개선 머신러리 — Playbook RL · whetstone · Skill 작성 · Reflection/dreaming · memory consolidation (worktree `/tmp/muse-self-improvement`, branch `loop/self-improvement`, Tier1.5 local-main merge ea 3 fires) | [self-improvement.md](self-improvement.md) | 9 | `b467b9c3` (fires 4-8 re-landed fire 9) | v2.0.0 | active (cron `0b48bb96`, session-only) |
| `computer-control` | local-12B multi-step computer-task reliability (eval:computer-task) — retheme from core-hardening (worktree `/tmp/muse-computer-control`, branch `loop/computer-control`, Tier2 push) | [computer-control.md](computer-control.md) | 3 | `54e86fee` | v2.0 | active (cron `18d30a58`, session-only) |
| `agent-hardening` | multi-agent decompose · recall/memory quality · one-shot tool-calling reliability (NARROWED; injection OUT) (worktree `/private/tmp/muse-agent-hardening`, branch `loop/agent-hardening`, Tier2 push) | [agent-hardening.md](agent-hardening.md) | 7 | `3666df61` | v2.0.0 | active (cron `ea6faad8`, session-only) |
| `grounded-vision` | 근거-있는 비전/멀티모달 — 이미지→근거-추출→draft-first 액션 (worktree `/tmp/muse-grounded-vision`, branch `loop/grounded-vision`, Tier2 push, merge-based git) | [grounded-vision.md](grounded-vision.md) | 2 | `ae37c354` | v2.0.0 | active (cron `abd98181`, session-only; replaces stopped paper-grounded) |

<!-- New loops: add a row here on first registration; update your own row's last-fire/commit each fire. -->
