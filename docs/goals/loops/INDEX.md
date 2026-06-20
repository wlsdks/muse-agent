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
| `surfaces` | 제품 표면 강화 — CLI · macOS desktop · web (worktree `/tmp/muse-surfaces`, branch `loop/surfaces`) | [surfaces.md](surfaces.md) | 52 | `eb3b7aa4` | v1.14.0 | active (cron `a55a7444`, session-only) |
| `test-hygiene` | 테스트 스위트 위생 — 저가치/중복 제거 + 누락 고가치 추가 + flaky 수정 (mutation-first) (worktree `test-hygiene`) | [test-hygiene.md](test-hygiene.md) | 52 | `c249c6d2` | v1.14.0 | active (cron `b7a92bf5`, session-only) |
| `context-strategy` | Context engineering — leanest sufficient context per turn (worktree `/tmp/muse-context-strategy`, branch `loop/context-strategy`) | [context-strategy.md](context-strategy.md) | 4 | `<commit-pending>` | v2.0.0 | active (cron `c66c8b81`, session-only, Tier2 push+PR, merge-to-main every 5 fires) |
| `core-hardening` | Muse 코어 엣지 강화 — grounding+citation 게이트 + 4 표면 (worktree `/tmp/muse-core-hardening`, branch `loop/core-hardening`, Tier2 push) | [core-hardening.md](core-hardening.md) | 5 | `e0916bd7` | v1.14.0 | active (cron `cfe778e2`, session-only) |

<!-- New loops: add a row here on first registration; update your own row's last-fire/commit each fire. -->
