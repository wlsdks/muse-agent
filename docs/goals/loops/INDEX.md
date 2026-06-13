# Loop index — all autonomous loops at a glance

> Thin aggregator (loop-creator v1.14.0+). One line per loop. Each loop updates ONLY its own row on
> commit, so this never becomes a contended append point. Detail lives in each loop's journal.
> Convention: [README](README.md).

| slug | theme | journal | last fire | last commit | skill | status |
|---|---|---|---|---|---|---|
| `tool-hardening` | TOOL expansion & hardening (main worktree) | [tool-hardening.md](tool-hardening.md) | 53 | `b7284276` | v1.14.0 | active (cron, session-only) |
| `cognition` | agent-core 인지 강화 (worktree `agent-core-enhance`) | [cognition.md](cognition.md) | 39 | — | — | superseded → re-registered as `agent-core-cognition` (v1.14.0, cron 39b9bdec) |
| `agent-core-cognition` | agent-core 인지 코어 강화 (worktree `agent-core-enhance`) | [agent-core-cognition.md](agent-core-cognition.md) | 2 | `71d5a6be` | v1.14.0 | active (cron 42e5d7ba, session-only) |
| `codebase-quality` | 코드베이스 내부 품질 (decompose/cohere/dead-code/주석 · @muse/recall 추출) (worktree `codebase-quality`) | [codebase-quality.md](codebase-quality.md) | 6 | (fire 6) | v1.14.0 | active (cron `81ac643b`, session-only) |
| `differentiation` | 경쟁 차별점 발굴 → edge 확장 vs hermes/openclaw (worktree `/tmp/muse-differentiation`) | [differentiation.md](differentiation.md) | 4 | `<pending>` | v1.14.0 | active (cron `80c4074b`, session-only) |

<!-- New loops: add a row here on first registration; update your own row's last-fire/commit each fire. -->
