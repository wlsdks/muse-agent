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
| `surfaces` | 제품 표면 강화 — CLI · macOS desktop · web · web콘솔 API (worktree `/tmp/muse-surfaces`, branch `loop/surfaces`) | [surfaces.md](surfaces.md) | 75 | `177d7ba9` | v2.0.0 | RETIRED (진안 wind-down: a11y 인풋 접근명 slice 출하, branch merged→main, worktree+cron 제거; ⚠ main에 타루프 autoconfigure HANG 블로커 잔존) |
| `test-hygiene` | 테스트 스위트 위생 — 저가치/중복 제거 + 누락 고가치 추가 + flaky 수정 (mutation-first) (worktree `test-hygiene`) | [test-hygiene.md](test-hygiene.md) | 52 | `c249c6d2` | v1.14.0 | active (cron `b7a92bf5`, session-only) |
| `context-strategy` | Context engineering — leanest sufficient context per turn (worktree `/tmp/muse-context-strategy`, branch `loop/context-strategy`) | [context-strategy.md](context-strategy.md) | 20 | `467d041b` | v2.0.0 | active (cron `f7d80487`, session-only, Tier2 push+PR, merge-to-main every 5 fires) |
| `core-hardening` | Muse 코어 엣지 강화 — grounding+citation 게이트 + 4 표면 (worktree `/tmp/muse-core-hardening`, branch `loop/core-hardening`, Tier2 push) | [core-hardening.md](core-hardening.md) | 9 | `0a6db466` | v2.0 | active (cron `d8c31fa3`, session-only) |
| `paper-grounded` | 논문-근거 차별화 기능 강화 — grounding/citation 게이트 · RGV verifier · Playbook · whetstone (worktree `/tmp/muse-paper-grounded`, branch `loop/paper-grounded-features`, Tier2 push, merge-based git) | [paper-grounded.md](paper-grounded.md) | 5 | `2a46383e` | v2.0.0 | fires 1-5 landed on main (eviction PEVI-parity dedup'd vs self-improvement; k-sample RGV merged); branch retired |
| `self-improvement` | hermes-style 자기개선 머신러리 — Playbook RL · whetstone · Skill 작성 · Reflection/dreaming · memory consolidation (worktree `/tmp/muse-self-improvement`, branch `loop/self-improvement`, Tier1.5 local-main merge ea 3 fires) | [self-improvement.md](self-improvement.md) | 9 | `b467b9c3` (fires 4-8 re-landed fire 9) | v2.0.0 | active (cron `0b48bb96`, session-only) |
| `computer-control` | local-12B multi-step computer-task reliability (eval:computer-task) — retheme from core-hardening (worktree `/tmp/muse-computer-control`, branch `loop/computer-control`, Tier2 push) | [computer-control.md](computer-control.md) | 59 | `ad6ddc17` | v2.0 | active (cron `47491301`, session-only; fire 59=@muse/fs file_list truncated false-positive fix; ⑤c[55-59] deferred, load~35) |
| `agent-hardening` | multi-agent decompose · recall/memory quality · one-shot tool-calling reliability (NARROWED; injection OUT) (worktree `/private/tmp/muse-agent-hardening`, branch `loop/agent-hardening`, Tier2 push) | [agent-hardening.md](agent-hardening.md) | 7 | `3666df61` | v2.0.0 | active (cron `ea6faad8`, session-only) |
| `poisoned-source` | GROUNDED≠TRUE 출처-진위 방어 — 오염된 노트/episode/MCP가 grounding 게이트 세탁 못 하게 (worktree `/tmp/muse-poisoned-source`, branch `loop/poisoned-source`, Tier2 push, merge-to-main ea 3 fires) | [poisoned-source.md](poisoned-source.md) | 18 | trust-aware conflict cue on ASK too + JUDGE-DRILL passed (FINAL — merged to main, loop retired) | v2.0.0 | retired (cron `cb79365d` deleted 2026-06-21) |
| `local-speed` | 로컬모델 속도/효율 라우팅(KV-quant·cascade·spec-decode) — 정확성 보존 (worktree `/tmp/muse-local-speed`, branch `loop/local-speed`, Tier2 push + 3-fire main merge) | [local-speed.md](local-speed.md) | 14 | `4a2c4587` | v2.0.0 | active (cron `481d865a`, session-only) |
| `multi-agent` | lead-worker 오케스트레이션 · 서브에이전트 핸드오프 신뢰성 (MAST coordination 가드 · 핸드오프 스키마 검증 · termination) (worktree `/tmp/muse-multi-agent`, branch `loop/multi-agent`, Tier2 push, merge-to-main ea 3 fires) | [multi-agent.md](multi-agent.md) | 15 | `d08bb006` (f15 PASS: completed human stderr signals) | v2.0.0 | active (cron `972211ed`, session-only) |
| `learning-surfacing` | 정체성 "Learns you, not the world." 체감화 — 학습 기계(user-model/Playbook/correction-decay)를 결정론+근거인용으로 surface (worktree `/tmp/muse-learning-surfacing`, branch `loop/learning-surfacing`, Tier2 push + 3-fire main FF-merge) | [learning-surfacing.md](learning-surfacing.md) | 22 | `6cd0603a` | v2.1.0 | active (cron `e8138ee2`, session-only 20m) |

| `cli-excellence` | 최고급 CLI — 첫 화면 완성도 · 표시 정보(상태/근거/학습/안내) 품질 · CLI 성능 (여신 아트 불가침) (worktree `/tmp/muse-cli-excellence`, branch `loop/cli-excellence`, Tier2 push + PR) | [cli-excellence.md](cli-excellence.md) | 7 | `305b844b` | v2.1.0 | active (cron `a4520c8e`, session-only 20m) |

| `desktop-enhance` | macOS desktop app 강화 + 뮤즈 캐릭터 상호작용 (번들 web 포함; ④c 브라우저 실측 검증) (worktree `/tmp/muse-desktop-enhance`, branch `loop/desktop-enhance`, Tier2 push + draft PR) | [desktop-enhance.md](desktop-enhance.md) | 14 | (pending) | v2.1.0 | active (cron `d7012104`, session-only 20m) |

<!-- New loops: add a row here on first registration; update your own row's last-fire/commit each fire. -->
