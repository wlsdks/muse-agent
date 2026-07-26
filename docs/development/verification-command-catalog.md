# Canonical verification command catalog

This catalog makes Muse verification results comparable across makers,
evaluators, and fresh checkouts. Run commands from the repository root with the
versioned Node and pnpm toolchain. A controller-enforced budget is an outer
deadline, not an implementation claim: most commands below do not enforce a
whole-command timeout themselves.

Before a run, create a private, ignored directory such as
`scratchpad/verification/011/2026-07-25T120000Z/`. Preserve the exact command,
HEAD, dirty-state summary, start/end timestamps, exit status, timeout status,
and stdout/stderr there. Do not copy credentials, bearer headers, prompt
secrets, or owner data into a failure log. A budget overrun is `unverified`;
do not silently retry it or report it as a product failure until the retained
partial output identifies which one it is.

## Command matrix

| Surface | Canonical command | Outer budget | Side effects and native timeout | Expected artifact | Valid skip condition | Failure preservation |
| --- | --- | ---: | --- | --- | --- | --- |
| TypeScript project graph | `pnpm typecheck:fast` | 10 min | TS7 project build can refresh generated package output and ignored `*.tsbuildinfo`. There is no whole-command native timeout. | Exit 0 plus captured compiler log bound to HEAD. Generated files are build output, not PASS evidence by themselves. | None for a source, test, executable script, build, dependency, schema, or enforced-policy slice. Docs/assets-only work may omit it only when the active gate says so. | Save the complete diagnostics and the first failing project in `typecheck.log`; retain generated-output diff separately if the command changed tracked files. |
| Affected tests | Edit loop: `pnpm test:changed --uncommitted`; slice gate: `pnpm test:changed` | 15 min | Reads Git staged, unstaged, untracked, and—without `--uncommitted`—committed paths since `origin/main`; runs related Vitest tests per affected TS/TSX workspace and launches Browser Mode when that workspace has a browser config. It has no whole-command timeout. | Exit 0 and captured workspace/test summary. | “No changed TypeScript files” is a valid no-op, not proof for changed `.mjs`, Rust, shell, docs, or config. Those files require their named deterministic test/gate. | Save `test-changed.log`, including changed-file discovery and the exact failing test/seed. Preserve Vitest counterexamples without rerunning to green. |
| Real Chromium | Component interaction: `pnpm --filter @muse/web test:browser`; critical journey: `pnpm test:e2e` | 15 min component; 25 min E2E | Browser Mode starts headless Chromium. E2E builds the workspace and starts local API/web servers; each Playwright server has a 120 s startup timeout, but neither command has a whole-command timeout. E2E may reuse already-running servers, so a fresh evaluator must first ensure they are the intended checkout. | Captured component/E2E console report; Playwright also retains a failure trace under `apps/web/test-results/**/trace.zip`. No HTML reporter is configured. | Skip only when no touched acceptance depends on DOM interaction, browser APIs, responsive layout, or a critical API/browser journey. Missing Chromium is `unverified`, not PASS. | Save `browser.log`; retain `apps/web/test-results/` before another run overwrites it. Record viewport/project and whether servers were newly started or reused. |
| Compiled CLI functional smoke | `pnpm smoke:cli` | 10 min | Builds `@muse/cli`, starts one loopback `@muse/api` child with the diagnostic model, allocates a free port, and isolates the scheduler file under an OS-temp root. Each CLI child has a 30 s timeout, API readiness has 30 s, and intended API shutdown has 5 s, but the harness has no whole-command timeout and inherits the rest of the caller environment. | Ten named check results, final `10 passed, 0 failed`, exit 0 within the outer budget, and no owned API child or temp scheduler root left behind. The summary without process exit is not PASS. | Skip only when the active acceptance touches neither compiled CLI behavior nor CLI/API process lifecycle. A controller timeout, signal exit, or leaked child is `unverified`/FAIL even when all ten functional checks printed PASS. | Save `smoke-cli.log`, timestamps, exit/signal, and the retained API tail. On a post-summary hang, record active handles/requests and owned-child ancestry for Task 041; terminate only the harness-owned process tree and preserve the exact timeout observation. |
| Local controlled-live smoke | `pnpm smoke:live` | 30 min | Probes local Ollama with a 1.5 s request timeout, starts the API in a disposable HOME/store root, waits up to 30 s for health, and kills API shutdown after 5 s. Individual RAG subprocesses have 120 s/180 s deadlines; there is no whole-suite native timeout. It may load local models and consume CPU/RAM, but must not use cloud keys or owner `~/.muse` state. | Streamed per-check `PASS`/`SKIP`/`FAIL`, final counts, and captured local API tail on failure. | Unreachable Ollama or no eligible chat-capable local model skips the whole command with exit 0. Provider/model capability can skip named checks. Every skip remains `unverified` for the corresponding live acceptance and cannot be counted as PASS. | Save `smoke-live.log` with model identifiers and partial checks. Do not preserve secret prompt or owner-state content. A leaked disposable root is itself a failure; record its path before cleanup only when needed for diagnosis. |
| Personal-agent qualification | `pnpm qualify:personal-agent` | 5 min | Read-only: does not start, stop, or signal a process; does not mutate stores or send. It reads current capability/evidence inputs. There is no whole-command native timeout. | Exact schema-v2 JSON stdout, including source start/end HEAD, generated time, expiry, input hash, runtime identity, three gates, and `readOnly: true`. Exit 0 only for `qualified`. | No skip can establish qualification. Missing, stale, malformed, unsupported, or incomplete evidence produces `unverified`/non-zero and must remain so. | Save exact stdout as `qualification.json` and stderr separately. Validate provenance against current HEAD and inputs before using it; never reuse an older green report. |
| Versioned pre-push gate | Normal configured-upstream push: `git push origin <current-branch>` | 20 min deterministic; 35 min with approved grounding opt-in | Acquires the shared repo push lock. From pushed ref tuples it selects typecheck, web typecheck, and scoped/full lint; docs/assets-only pushes skip deterministic gates. `MUSE_RUN_PREPUSH_GROUNDING=1` adds the path-scoped live battery. The hook has no whole-command deadline; push changes the configured remote only after it passes. | Full hook/push log, local commit SHA, and matching `origin/<current-branch>` SHA after the push. | Path-classified stages may print a documented skip. Grounding is opt-in, but a required live acceptance remains `unverified` when skipped. `MUSE_SKIP_PREPUSH_ALL`, `--no-verify`, force, alternate remote/refspec, and tag/release publication are not valid skips. | Save `pre-push.log` and both SHAs. On hook/auth/protection/divergence failure preserve the first log; allow at most one safe fetch/rebase retry under the repository publication policy. |

## Interpretation rules

- Exit 0 means only what that command owns. In particular,
  `test:changed` is not the merge proof, pre-push does not run the full test
  suite, and an exit-0 live smoke with skips is not a live PASS.
- Required evidence is conjunctive. Deterministic, real-browser,
  real-backend, controlled-live, qualification, and independent-evaluator
  evidence cannot substitute for one another.
- Run the narrow named regression first. After source or behavior changes,
  still run `pnpm test:changed`; when it reports no changed TypeScript, record
  that observation and run the appropriate `.mjs`, Rust, shell, or platform
  gate explicitly.
- A fresh evaluator reruns the acceptance commands from a clean checkout or
  isolated fixture. It receives the activation handoff, acceptance criteria,
  current diff, and verification targets—not the maker's private conversation.
- The normal push hook is the canonical publication path. Directly invoking
  `scripts/githooks/pre-push` selects a fail-closed full fallback and can test
  the hook, but it does not prove a remote update.
