# Loop journal — `cli-excellence`

Theme: making the `muse` CLI best-in-class against competitors — ① first-screen polish ② quality of displayed information (status/evidence/learning/guidance/progress) ③ CLI performance. The goddess mascot art belongs to Jinan (inviolable). Tier2 (worktree `/tmp/muse-cli-excellence`, branch `loop/cli-excellence`, push + PR; merging to main is Jinan's call). cron `a4520c8e` (20m, session-only).

Convention: [README](README.md).

## fire 1 · 2026-06-21 · skill v2.1.0 · 29414fb0
meta: value-class=new-capability · pkg=@muse/cli · kind=info-projection · verdict=PASS · firesSinceDrill=1
ratchet: testFiles +0 (added 5 cases to existing commands-status.test.ts) · @muse/cli 2881 green · check exit 0 · smoke:cli 9/9 · lint 0 · fabrication 0

- **What**: Added a privacy-posture (local-only) line to the `muse status` at-a-glance dashboard + `--json` snapshot. New exported pure helper `formatPrivacyPosture(snapshot)` + `localOnly: evaluateLocalOnlyPosture(process.env)` added to `collectStatus` (additive, schema v1 preserved) + a single `privacy:` line after the providers block in `renderStatus`.
- **Why**: Muse's #1 identity ("local by default, cloud egress refused") already exists in `muse doctor` but was missing from the at-a-glance dashboard people see daily. The facts are derived from the **same single source of truth** as doctor, `evaluateLocalOnlyPosture` → the two surfaces can never disagree on posture. fabrication=0: each of the 4 phrasings is strictly entailed by its (enabled,status) pair ("egress blocked/possible", "no cloud credentials").
- **Review point**: the phrasing is glance-sized (not detail-verbatim), and precise diagnostics (which cloud key/off-box embedder URL) are delegated to `muse doctor` — the single source of truth is the facts (enabled/status), not the prose, so there's no divergence risk. The independent Opus ④b judge PASSED.
- **Risk**: low. The diff is confined to commands-status.ts + its test. Goddess-art invariant respected. A nit the ④b judge caught (the wiring test only cleared 4 of the 5 canonical cloud keys — missing GOOGLE_API_KEY) was hardened immediately (all 5 cleared).
- **Reference**: claude-code (tree format)·gemini-cli (box layout)·starship/oh-my-posh (at-a-glance status display) first-screen conventions — displayed information should be "at a glance, honest." https://shipyard.build/blog/claude-code-vs-gemini-cli/ · https://github.com/ratatui/ratatui

### sibling-audit (not applied this fire → backlog)
- The bottom chat-REPL HUD (chat-ink.ts:822-833) shows model·proactive·agent·tools·skills·tokens but **doesn't display local-only posture** — same class sibling. Space-constrained + live-state, so deferred to a separate fire (a different (pkg,kind)).

## fire 2 · 2026-06-21 · skill v2.1.0 · 009800bf
meta: value-class=new-capability · pkg=@muse/cli · kind=first-screen/onboarding · verdict=PASS · firesSinceDrill=2
ratchet: testFiles +1 (program-help.test.ts) · @muse/cli 2895 green · check exit 0 · smoke:cli 9/9 · lint 0 · fabrication 0

- **What**: Added a local-first "60-second quickstart" block to `muse --help` / the non-TTY first screen (pipes·CI·`muse | cat`). New pure export `museQuickstartHelp()` + wired via `addHelpText("after", …)` in `createProgram`. 4 real commands (muse / muse setup local / muse remember / muse status) + an identity-lead line ("LOCAL model by default; cloud egress refused unless you opt out").
- **Why**: commander's default help only lists commands — it told a first-time discoverer neither "what to do first" nor "local-first." Puts 60-seconds-to-value (a web-research benchmark) right on the first screen. fabrication=0: every line is a real command, claims grounded in local-only-policy.ts/CLAUDE.md.
- **Review point**: the wiring test grades actual render output (not declaration), mutation-first RED confirmed. The root addHelpText("after") doesn't leak into subcommand help (0 quickstart occurrences in `muse status --help`). Diff confined to program.ts + a new test, goddess-art invariant respected. Independent Opus ④b judge PASSED (6/6).
- **Risk**: low. Diversity: fire1=info-projection(status) → fire2=first-screen(--help), a different kind.
- **Reference**: gemini-cli vs claude-code first-screen comparison + 60-second-to-value onboarding. https://shipyard.build/blog/claude-code-vs-gemini-cli/ · https://www.appcues.com/blog/best-user-onboarding-examples
- lesson: in a concurrent-loop environment, a fire-start fetch goes stale quickly — while attempting to self-fix a raw-NUL byte-hygiene regression pulled in by a merge, discovered origin/main already had the canonical fix (commit 4871aca9, backslash-u-0000 escape) → discarded the self-fix and re-merged latest origin/main to adopt the canonical one. Lesson: before self-patching a regression pulled in by a merge, check whether origin already fixed it (avoid a divergent fix). Also, self-eval doesn't run the full test suite so it can't catch a byte-hygiene regression — `pnpm check` is the real gate.

## fire 3 · 2026-06-21 · skill v2.1.0 · 7cf0571e
meta: value-class=new-capability · pkg=@muse/cli · kind=first-screen/identity-copy · verdict=PASS · firesSinceDrill=3
ratchet: testFiles +1 (muse-identity.ts new; tests in program-help+muse-banner) · @muse/cli 2900 green · smoke:cli 9/9 · lint 0 · fabrication 0

- **What**: Aligned two first-screen taglines on a single-source-of-truth const `MUSE_TAGLINE` ("The personal AI that learns you — local-first, private by default"). Both `muse --help`'s description ("Model-agnostic inspirational AI agent") and the REPL banner tagline ("your personal AI agent & assistant") were generic and inconsistent → new `muse-identity.ts` const shared by program.ts (.description) and muse-banner.ts (tagline). Goddess-art invariant respected (only the tagline line changed).
- **Why**: the headline a user reads first on the first screen was hiding the product identity ("Learns you, not the world"·local-first) and reading like a generic LLM wrapper. A single const means the two surfaces can never drift (reapplying fire 1's single-source-of-truth pattern).
- **Review point**: the wiring test grades the actual render (banner string + outputHelp), mutation-first RED confirmed (mutating the const→identity+banner RED; mutating .description/tagline wiring→the matching test RED). Live-verified both `--help`+the banner show the new tagline. Independent Opus ④b judge PASSED (7/7). Grounding: based on the CLAUDE.md identity + the local-only default posture.
- **Risk**: low. Diff spans 5 files (new muse-identity.ts + program.ts + muse-banner.ts + 2 tests). Diversity: fire1=info-projection(status)→fire2=onboarding(--help quickstart)→fire3=identity-copy(tagline, --help+banner), a different kind.
- **Reference**: claude-code/gemini-cli first-screen headline·identity-display conventions. https://shipyard.build/blog/claude-code-vs-gemini-cli/
- note: a full `pnpm check` had 1 RED — @muse/model/web-search-policy's property-fuzz "Test timed out 5000ms" (8.6s) — but this was a false-timeout from box saturation (~17 concurrent loops), not my @muse/cli slice (384 green when re-run isolated). [[project_test_hygiene_loop]] pattern. The slice itself shipped since build/narrow-test/mutation/smoke/lint were all green.

## fire 4 · 2026-06-21 · skill v2.1.0 · c9fc1ce6
meta: value-class=new-capability · pkg=@muse/cli · kind=render · verdict=PASS · firesSinceDrill=4
ratchet: testFiles +0 (2 cases into chat-ink-render.test.ts) · @muse/cli HUD test isolated green · smoke:cli 9/9 · lint 0 · fabrication 0

- **What**: Added a local-only posture badge to the bottom HUD of the interactive chat REPL — `🔒 local` (green) / `⚠ cloud` (yellow) after the model. Derived from `evaluateLocalOnlyPosture(process.env).enabled` (the same source of truth as doctor·status), mirroring the existing `proactiveOn` prop flow. Added props.localOnly + a runChatInk computation + HUD render.
- **Why**: the most-viewed first screen (the live REPL) was silent about Muse's #1 identity (blocked cloud egress). Following fire1 (status)·fire3 (tagline), three first screens (--help/banner/status/HUD) now all agree on posture — fabrication 0 (strict on a boolean).
- **Review point**: ink-testing-library grades the actual render frame (lastFrame) (on→🔒/off→⚠), mutation-first RED confirmed (hardcoding the badge→off-case RED). It's a required prop so every constructor (runChatInk + test makeProps) must supply it → no undefined render (guaranteed by tsc). Independent Opus ④b judge PASSED (7/7). Goddess-art invariant respected.
- **Risk**: low. Diff spans 2 files (chat-ink.ts + a test). chat-ink.ts is high-contention so a future merge could conflict — the HUD segment is an independent flex child so it's isolated. Diversity: fire1 info-projection→fire2 onboarding→fire3 identity-copy→fire4 render, all different kinds.
- **Reference**: starship/oh-my-posh status-segment (a posture badge in the prompt) convention. https://starship.rs/
- note: the full @muse/cli test suite had 2 RED but both were "Test timed out 5000ms" (document-reader PDF 5251ms, existing /forget 6992ms) — box-saturation false-timeouts, both green when re-run isolated, not my HUD test. Shipped since the slice's own gates (build/HUD-test isolated/mutation/smoke/lint) were all green.

## fire 5 · 2026-06-21 · skill v2.1.0 · 915df67a
meta: value-class=perf+correctness · pkg=@muse/cli · kind=perf · verdict=PASS · firesSinceDrill=5
ratchet: testFiles +1 (muse-version.test.ts, 7 cases) · `muse --version` ~500ms→~90ms · corrected 0.0.0→0.1.0 · lint 0 · fabrication 0

- **What**: A pre-framework fast path for `muse --version`. index.ts statically imported program.ts (a ~100+ module graph), so even a trivial `--version` paid a ~0.5s tax → new leaf `muse-version.ts`'s `tryVersionFastPath` handles only `--version`/`-V` before the framework loads and exits, everything else now **dynamically imports** program.ts (the key to bypassing the graph). Also replaced `.version("0.0.0")` (mismatched with the real 0.1.0 — a wrong-info bug) with a single-source-of-truth `MUSE_CLI_VERSION`.
- **Why**: `--version` is the most common probe from wrappers/shell-completions/CI health checks yet paid the full import tax (③ startup speed). Measured: fast-path ~90ms vs full-graph (--help) several seconds (saturated). Also the first-screen version string was wrong (tag v0.1.0/CHANGELOG/root pkg all say 0.1.0). A single const + a root-pkg drift test blocks future divergence.
- **Review point**: tests grade actual output (the fast-path write string·commander's `.version()`·the live dist), mutation-first RED (version→0.0.0 flags a drift/stale RED; guard→false is handled RED). The dynamic import preserves dispatch (--help/mcp/scheduler/spec/chat --help all still work). The fast path handles exactly `--version`/`-V` alone (length===1), everything else falls through. Independent Opus ④b judge PASSED (7/7). Goddess-art invariant respected.
- **Risk**: low. Diff spans 4 files (index.ts·program.ts 1 line·new muse-version.ts·a test). Diversity: fires 1-4 (info-projection/onboarding/identity-copy/render, posture/identity value-classes) → fire5 is clearly a different **perf axis** (startup cost), a distinct kind/value-class.
- **Reference**: CLI startup-performance optimization (--version/--help are the most-called, lazy-load is the biggest win). https://github.com/oclif/oclif/issues/606
- note: smoke:cli was 7 pass / 2 fail (`muse chat`·`--stream` "got null"=spawnSync 30s timeout, box saturation). **A/B isolation**: reverted index.ts to the original static import, rebuilt, and re-ran — the same 2 chat round-trips still failed identically → not my slice's fault (saturation/merge-caused). Every non-round-trip probe (including `--version`) PASSED. Shipped since the slice's own gates (build/version-test isolated 7/7/mutation/lint) were green.
- lesson: when a stop-condition gate (smoke:cli) is RED, don't just assume "environmental" — **isolate with A/B** (temporarily revert your change and reproduce the same failure) to prove it's not a regression. `git stash` is forbidden, so used `cp` for a temporary backup/restore.

## fire 6 · 2026-06-21 · skill v2.1.0 · 1b6a01c1
meta: value-class=empty-state · pkg=@muse/cli · kind=empty-state · verdict=PASS · firesSinceDrill=6
ratchet: testFiles +0 (4 cases into commands-notes-rag.test.ts) · @muse/cli notes-rag test isolated green · lint 0 · fabrication 0

- **What**: `muse notes reindex` printed `Done. 0 embedded, 0 cached, 0 failed` even with zero markdown files, indistinguishable from a silent failure → added `ReindexSummary.totalFiles` (additive) + a pure `formatReindexOutcome` that, when totalFiles===0, prints an action-bearing empty state ("No notes to index — found 0 ... under <dir>" + `muse note` + `MUSE_NOTES_DIR` + ask/recall guidance), otherwise the existing Done line. The found-but-all-failed path is unchanged (still Done+counts+Ollama guidance).
- **Why**: RAG over notes is the second-brain foundation (ask/recall/today --connect/status). A fresh `muse setup local` user's first reindex on an empty/misconfigured vault was a dead end (the NN/G "totally empty state" antipattern). Every number = an fs walk, every suggested command is real (fabrication 0).
- **Review point**: the tests grade the helper's return string + the actual tmp-dir totalFiles + a live command (not declaration), mutation-first RED (disabling the empty-state branch/pinning totalFiles to 0 both go RED). The judge independently confirmed the all-failed edge case doesn't trigger the empty state. Independent Opus ④b judge PASSED (7/7). Goddess-art invariant respected, low-contention file.
- **Risk**: low. Diff spans 2 files (commands-notes-rag.ts + a test). totalFiles is additive (the 3 other call sites only read fields, no shape assertion). Diversity: fires 1-5 (info-projection/onboarding/identity-copy/render/perf) → fire6 is empty-state, a new kind.
- **Reference**: NN/G empty-state design guidance (an empty state should suggest the next action). https://www.nngroup.com/articles/empty-state-interface-design/
- note: smoke:cli was 7 pass / 2 fail (`muse chat`·`--stream` "got null"=30s timeout) — the same probe A/B-confirmed environmental in fire 5; my slice touches the notes path, unrelated to chat/api (0 new failures).

## fire 7 · 2026-06-21 · skill v2.1.0 · 305b844b
meta: value-class=error-guidance · pkg=@muse/cli · kind=error-guidance · verdict=PASS · firesSinceDrill=7
ratchet: testFiles +0 (3 cases into program-help.test.ts) · @muse/cli formatUnknownCommand isolated green · lint 0 · fabrication 0

- **What**: An unknown `muse <x>` with no near-match dead-ended into "unknown command" + "run --help" (a 100+ command dump) → extracted a pure `formatUnknownCommand`: the near-miss "Did you mean" path is unchanged, but the no-match case now adds a POPULAR (chat·ask·status·today·remember·setup) discovery on-ramp. POPULAR is **intersected with the live registry** (listAllCommandNames) → only real commands are shown (fabrication 0).
- **Why**: guides typos/new-user guesses toward daily-driver commands instead of a dead end. Follows the claude-code/git "did you mean" + discovery-hint convention. Every name is a registered real command (guaranteed by intersection).
- **Review point**: the tests grade the returned string (near-miss vs no-match vs registry-intersected) + live output, mutation-first RED (emptying POPULAR reds 2 tests, near-miss stays green). The near-miss path is preserved byte-identical + exitCode=1 kept. No existing test asserts the old text (0 regressions). Independent Opus ④b judge PASSED (7/7). Goddess-art invariant respected.
- **Risk**: low. Diff spans 2 files (program.ts + a test). Diversity: fires 1-6 (info-projection/onboarding/identity-copy/render/perf/empty-state) → fire7 is error-guidance, a new kind.
- **Reference**: git "did you mean" + CLI discoverability (unknown→top commands) convention. https://www.npmjs.com/package/commander
- note: smoke:cli was 7 pass / 2 fail = the fire-5 A/B-confirmed chat round-trip environment timeout, unrelated to my unknown-command change (`muse --help` probe PASSED).

## fire 8 · 2026-06-22 · skill v2.1.0 · f2dba36f
meta: value-class=info-projection · pkg=@muse/cli · kind=info-projection · verdict=PASS · firesSinceDrill=8
ratchet: testFiles +0 (1 case into commands-status.test.ts + 1 existing assertion updated) · @muse/cli 2953 green · check 0 · smoke:cli 9/9 · lint 0 · fabrication 0

- **What**: Humanized the 7 raw-UTC-ISO timestamps in the `muse status` at-a-glance dashboard (last update/followups next/episodes last/patterns last/reminders next/cost as of/last notice) via the shared `formatRelativeTime` — ≤7d shows "3h ago"/"in 2d", >7d shows a readable local datetime, invalid values pass through unchanged. `--json`/collectStatus still return raw ISO (for machine consumers).
- **Why**: an at-a-glance surface with `2026-06-05T19:34:48.334Z` isn't readable at a glance (an observed real-usage problem for Jinan). A deterministic conversion (fabrication 0), reusing an existing helper.
- **Review point**: verified LIVE hands-on (`node dist/index.js status` → confirmed "last update: 2026-06-06 04:34"), mutation-first RED (removing the relative conversion→raw ISO), a new test seeds now-3h→"3h ago". ★maker≠judge earned its keep here: the ④b judge caught a **full-suite regression** (program.test.ts's cost line asserted raw ISO) → FAILed it → the existing assertion was updated to the humanized form (formatLocalDateTime) → re-judged PASS (5/5). Sibling audit: grepped every other status ISO assertion (none found). Goddess-art invariant respected.
- **Risk**: low. Diff: commands-status.ts + its test + 1 existing assertion in program.test.ts.
- lesson: when you change a display render, don't just check the narrow file test (commands-status.test.ts) — run the **full @muse/cli suite** to catch cross-file assertion regressions (program.test.ts had pinned the old output). Sibling audit means not just src siblings but also the test siblings that assert its output.
- reference: at-a-glance status displays like starship/lazygit use relative-time convention. https://starship.rs/

## fire 9 · 2026-06-22 · skill v2.1.0 · 991c1de7
meta: value-class=render+identity-copy · pkg=@muse/cli · kind=render · verdict=PASS · firesSinceDrill=9
ratchet: only ran change-related tests (heat policy) · muse-banner.test 3/3 · live render confirmed · lint 0 · fabrication 0

- **What**: Applied Jinan's first-screen feedback. ① tagline (+status/hint) indentation 3→2 spaces (matches the art·chat-ink paddingLeft:2 recap/input column) ② removed the decorative cyan rule (`─`×38) under the tagline (+dropped the test's dependency on that color) ③ regenerated the mascot at 64→**56 columns** (gen-mascot-ansi.mjs, same hi-res master, sextants preserve quality; Jinan picked 56). + fixed a version drift 0.1.0→0.1.1 (the v0.1.1 release, caught by the fire-5 guard).
- **Why**: Jinan looked at the live splash and flagged it — too much left-padding on the tagline (3 vs 2), an unexplained sky-blue line, a too-large character. The mascot resize is per Jinan's explicit instruction (owner approval).
- **Review point**: live hands-on verification (tagline at 2 spaces·no rule·`--version` shows 0.1.1) + read the 56-column mascot preview PNG to check quality (compared 64/52/44 and chose 56; eyes·face·hair·halo still clear). mutation-first (banner tests). ★the ④b judge again earned its keep: verified the color-mode assertion depended on the removed rule and confirmed the replacement with `\x1b[38` (the mascot's true-color code) wasn't cheating. byte-hygiene raw 0x1B=0. Independent Opus ④b judge PASSED (7/7).
- **Risk**: low. Diff spans 4 files (banner/test/mascot/version). The mascot regeneration is machine-generated (byte-identically reproducible). Diversity: render kind.
- live: `node dist/index.js` splash = mascot (56×33) → 2-space tagline → (no rule); confirmed good quality at 56 columns via the preview PNG.
- reference: starship/lazygit left-aligned single-column splash; sextant (U+1FB00) 2×3 subpixel rendering. https://starship.rs/
- ★heat-policy switch (Jinan, 2026-06-22): starting this fire, full-suite/`pnpm check`/smoke are no longer run every fire → only change-related vitest files. cron re-registered from 92b2d826→e5696b6a with lighter ④/④b gates. [[feedback_minimal_test_runs]]

## fire 10 · 2026-06-22 · skill v2.1.0 · 28cbf359 · ★JUDGE-DRILL
meta: value-class=onboarding · pkg=@muse/cli · kind=onboarding · verdict=PASS · firesSinceDrill=0 (reset)
ratchet: only change-related tests (heat policy) · chat-ink-core+chat-ink-nomodel 2 green · lint 0 · fabrication 0

- **What**: A new user running `muse` with no model configured saw a flat `muse: no model configured yet.` error → replaced with identity-led local-first onboarding. Extracted a pure `formatNoModelMessage()` (chat-ink-core, MUSE_TAGLINE + local(free/private)·cloud(opt-in)·`muse setup wizard`) + **wired** into runChatInk's no-model branch.
- **Why**: a brand-new user's true first screen (zero-config) didn't show product identity. Every command mentioned is real (setup local/model/wizard), framed local-first by default.
- **Review point**: ★this fire is the JUDGE-DRILL (firesSinceDrill=10/consecutiveAllPASS9≥8). First submitted an **inert (helper+test only, unwired)** version to the independent ④b — the judge correctly FAILed it ("dead code, live path unchanged, only isolated in tests" — proving the verifier has teeth). Then wired it into runChatInk + added a **wired-path integration test** (vi.mock createMuseRuntimeAssembly→no-provider, drives runChatInk, captures stderr). Mutation-first on both sides (the copy + the wiring; reverting the wiring reds the integration test). Re-judged PASS (6/6).
- **Risk**: low. Diff spans 4 files. Early-return (exitCode=1) preserved. Diversity: onboarding kind. A localized edit to chat-ink.ts (one branch).
- live: the no-model branch is TTY-only, so instead of a direct shell capture, a vi.mock integration test grades the live path.
- lesson: "add a helper + a test" alone can still be inert — a display change must be backed by a test that **grades the wired path** (here, driving runChatInk via vi.mock) to count as real. The JUDGE-DRILL proved this concretely.
- reference: 60-seconds-to-value onboarding (the first screen should clearly point to one next action). https://www.appcues.com/blog/best-user-onboarding-examples

## fire 11 · 2026-06-22 · skill v2.1.0 · d650e179
meta: value-class=render · pkg=@muse/cli · kind=render · verdict=PASS · firesSinceDrill=1
ratchet: only change-related tests (heat policy) · commands-doctor doctorStatusMarker 1 green · lint 0 · fabrication 0

- **What**: In the `muse doctor --local` health screen, a WARN check rendered as a neutral `·`, indistinguishable from an OK `✓` (23 lines with "needs attention" invisible). Extracted a pure export `doctorStatusMarker(status)` (ok→✓/warn→⚠/fail→✗) and wired it into formatLocalDoctor. warn=⚠ is now scannable.
- **Why**: the whole point of a health check is "what's wrong, at a glance" (the brew/flutter doctor convention). `·` looked identical to OK, so warnings were buried. Pure presentation (classification/counts/--full JSON unchanged), ⚠ is consistent with the CLI's existing warning glyphs.
- **Review point**: the tests grade the 3 mappings + warn≠"·" (confirms wiring), mutation-first RED (reverting warn→· fails). Live-verified all 3 warns show ⚠ in `doctor --local`. Sibling audit: grepped for any test asserting the old `·` marker (none found). Independent Opus ④b judge PASSED (6/6).
- **Risk**: low. Diff spans 2 files (commands-doctor.ts + a test). Diversity: render kind (fires 4/9 were also render, but not ≥6 of the last 8). Unrelated to the goddess art.
- live: `node dist/index.js doctor --local` → `⚠ ollama-perf…` `⚠ at-rest encryption…` `⚠ mcp.json…` + `Overall: WARN — 3 warning(s) (20 ok / 3 warn / 0 fail)`.
- reference: brew/flutter doctor's scannable-marker convention ([!]/⚠). https://docs.flutter.dev/reference/flutter-doctor

## fire 12 · 2026-06-22 · skill v2.1.0 · 03b3d3c2
meta: value-class=progress · pkg=@muse/cli · kind=progress · verdict=PASS · firesSinceDrill=2
ratchet: only change-related tests (heat policy) · commands-notes-rag 43/43(whole file) · lint 0 · fabrication 0

- **What**: Added a `[i/N]` position prefix to `muse notes reindex`'s per-file onProgress lines (which one out of found.length). Cached (skip) files stay silent. Only embedded/failed lines show position.
- **Why**: a long reindex streamed `+path` lines with no position, looking "stuck" (③ responsiveness). progress is a fresh kind (avoids the last 3 render kinds). The counters use the real loop index+found.length, so fabrication 0, presentation-only (counts/index unchanged).
- **Review point**: the tests grade the real onProgress capture ([1/2]/[2/2]), mutation-first RED (removing the prefix fails). Live-verified a 3-file reindex shows `[1/3][2/3][3/3]`. ★maker≠judge earned its keep again: the first ④b caught a **sibling regression** (a corrupt-PDF test asserted startsWith("✗")) → FAILed it → fixed that assertion to a regex matching the `[i/N]` prefix → re-judged PASS (5/5). commands-read uses a separate prefix-less emitter, unaffected (14/14).
- **Risk**: low. Diff spans 2 files.
- live: `node dist/index.js notes reindex --dir <3 notes>` → `[1/3] + …a.md` `[2/3] + …b.md` `[3/3] + …c.md` `Done. 3 embedded`.
- lesson: when changing an output format, **grep every test that asserts that output** (startsWith/toContain) and fix siblings in the same fire — running only a narrow `-t` test misses cross-file sibling regressions (the judge caught it by running the whole file). Sibling audit = not just src, but also the tests asserting its output.
- reference: `[i/N]` progress notation (npm/pip/lazygit-style position counters). https://github.com/jesseduffield/lazygit

## fire 13 · 2026-06-22 · skill v2.1.0 · 40afdeec
meta: value-class=first-screen · pkg=@muse/cli · kind=first-screen · verdict=PASS · firesSinceDrill=3
ratchet: only change-related tests (heat policy) · program-help sort test 1 green · lint 0 · fabrication 0

- **What**: `muse --help`'s ~80 commands were listed in insertion order, unscannable → alphabetized via `configureHelp({sortSubcommands,sortOptions})`. Commands are now findable by first letter. The quickstart block below still highlights the daily drivers. Display-only (no commands added/removed/renamed, dispatch unchanged).
- **Why**: discoverability (②/① first screen). gh/docker sort/group; 80 items in insertion order is a wall. Sorting is a commander-native single-fire win (grouping is bigger work → follow-up).
- **Review point**: the tests grade the actual outputHelp order (chat<spec only holds after sorting since chat is registered after spec — not coincidental), mutation-first RED (removing configureHelp→insertion order→fail). Live-verified `--help`'s Commands section is A-sorted (actions/agent-notices/agents/analytics…). Sibling audit: no test asserts command insertion order (chat-ink's /help is a separate surface). The Did-you-mean path is unaffected. Independent Opus ④b judge PASSED (6/6).
- **Risk**: low. Diff spans 2 files. Diversity: first-screen kind.
- live: `node dist/index.js --help` — Commands section alphabetized.
- ◦ FOLLOW-UP (backlog): categorizing the 80 commands (gh-style CORE/…) is possible via commander helpGroup (13+) but is a large curation effort → needs decomposition.
- reference: gh/docker command grouping·sorting conventions. https://cli.github.com/manual/

## fire 14 · 2026-06-22 · skill v2.1.0 · 5c4a4640
meta: value-class=info-projection · pkg=@muse/cli · kind=info-projection · verdict=PASS · firesSinceDrill=4
ratchet: only change-related tests (heat policy) · commands-doctor formatDoctorSummaryLine 3 green · lint 0 · fabrication 0

- **What**: Humanized the raw-UTC-ISO stamp (`(2026-06-21T16:09:48.322Z)`) in the plain `muse doctor` one-line summary. Extracted a pure export `formatDoctorSummaryLine(snapshot, now)` (shared formatRelativeTime: just now/3h ago/>7d local datetime/absent omits it) + wired into the action. Sibling-completes fire-8 (status timestamps).
- **Why**: how stale a health snapshot is required mental math with raw ISO. "(just now)/(Nh ago)" shows staleness immediately. Deterministic (now is injected), --full/--json/--local paths unchanged.
- **Review point**: the tests grade the returned line ([ok] … (3h ago), no raw ISO, absent→stamp omitted), mutation-first RED (restoring the raw stamp→2 fails). Live-verified `muse doctor` → `[OK] 6 sections — OK 6 (just now)`. Sibling audit: no test asserts the old raw summary (today's generatedAt is a separate surface). Independent Opus ④b judge PASSED (6/6).
- **Risk**: low. Diff spans 2 files. The DoctorSummary export is benign. Diversity: info-projection (1 of the last 8).
- live: `node dist/index.js doctor` → `[OK] 6 sections — OK 6 (just now)`.
- reference: at-a-glance status uses relative-time (same pattern as fire-8, brew/flutter doctor staleness notation). https://docs.flutter.dev/reference/flutter-doctor

## fire 15 · 2026-06-22 · skill v2.1.0 · 10ca51f1
meta: value-class=info-projection · pkg=@muse/cli · kind=info-projection · verdict=PASS · firesSinceDrill=5
ratchet: only change-related tests (heat policy) · commands-remind formatReminderList 3 green(whole file 28/28) · lint 0 · fabrication 0

- **What**: `muse remind list` displayed overdue pending reminders identically to upcoming ones — no way to scan what's late (4 items had been overdue for weeks with no marker). Added `(⚠ overdue)` for pending & dueAt<now (following the existing (repeats)/(fired) suffix convention). Exported formatReminderList + injected nowMs. fired reminders stay unmarked (already fired), bad/absent dueAt is safely ignored.
- **Why**: late items need to be visible at a glance (status only had an "(N overdue)" count, list had no per-item marker). Deterministic (real timestamp comparison), fabrication 0.
- **Review point**: the tests grade actual formatted output (past→(⚠ overdue), future unmarked, fired unmarked), mutation-first RED (disabling the overdue branch fails). Live-verified all 4 reminders show `(⚠ overdue)` (a repeating one shows `Exercise (⚠ overdue) (repeats daily)`). Independent Opus ④b judge PASSED (6/6).
- **Risk**: low. Diff spans 2 files. Export+optional param is backward compatible. Diversity: info-projection (2 of the last 8, but a different surface=remind).
- live: `node dist/index.js remind list` → each overdue reminder shows `(⚠ overdue)`.
- reference: overdue-highlighting convention in todo/reminder UIs (red/⚠). https://todoist.com/help

## fire 16 · 2026-06-22 · skill v2.1.0 · 335a4741
meta: value-class=info-projection · pkg=@muse/cli · kind=info-projection · verdict=PASS · firesSinceDrill=6
ratchet: only change-related tests (heat policy) · chat-repl formatReminderList 2 green · lint 0 · fabrication 0

- **What**: Sibling-completes fire-15 — added `(⚠ overdue)`/`(⚠ 지남)` markers to the in-chat reminder list too ("what reminders do I have?", chat-repl formatReminderList). Added an optional `overdue?` to the formatter + computed dueAt<now at the call site (which already filters pending). Korean-aware.
- **Why**: consistency between `muse remind list` (fire 15) and the in-chat path — late reminders should be scannable on both surfaces. Deterministic (real dueAt), fabrication 0, fired reminders already excluded by the call site's filter.
- **Review point**: the formatter test grades actual output (KO 지남/EN overdue, future unmarked), mutation-first RED (disabling the marker reds 2 tests). The in-chat path is model intent-gated so live headless testing isn't possible — a pure formatter unit test + call-site dueMs<now (mirroring fire-15's verified logic) is sufficient. Independent Opus ④b judge PASSED (6/6). Non-pending items can't reach the marker due to the call site's filter.
- **Risk**: low. Diff spans 2 files. Optional field is backward compatible. Diversity: info-projection (parity completion).
- live (test substitute): the formatter's unit test confirms the marker renders (the in-chat path is intent-gated).
- reference: same as fire 15 (overdue-highlighting convention).

## fire 17 · 2026-06-22 · skill v2.1.0 · c84cdcf0
meta: value-class=info-projection · pkg=@muse/cli · kind=info-projection · verdict=PASS · firesSinceDrill=7
ratchet: only change-related tests (heat policy) · human-formatters 33/33 · root-eslint 0 · fabrication 0

- **What**: `muse tasks list` displayed past-due tasks identically to upcoming ones (all 31 items in the box had been overdue for weeks with no marker) → `(⚠ overdue)` for not-done & dueAt<now (formatTaskRow). Extends fire 15/16's (reminder) pattern to tasks. nowMs injected, done/undated/unparseable are safely excluded.
- **Why**: late items in a daily-driver surface (31 items) need to be visible at a glance. Deterministic, fabrication 0. ⚠ is already used for the urgent badge in this file, so it's consistent.
- **Review point**: the tests grade actual rendered rows (past→(⚠ overdue), future/done unmarked), mutation-first RED. Live-verified `tasks list` shows all 31. Sibling audit: the only caller is commands-tasks (today only uses formatLocalDate, chat-repl has a separate formatTaskList), the existing urgent tests are unaffected (33/33). Independent Opus ④b judge PASSED (5/5).
- **Risk**: low. Diff spans 2 files. nowMs optional, backward compatible.
- lesson: use **`./node_modules/.bin/eslint`** for scoped lint instead of `npx eslint` (which may not read the root flat config) — the ④b judge caught 2 no-regex-spaces (a doubled space in a regex) violations I missed in the first round. Use a `{2}` quantifier for consecutive spaces in a regex literal.
- live: `node dist/index.js tasks list` → past tasks show `(⚠ overdue)`.
- reference: fire 15/16 (overdue-highlighting convention).

## fire 18 · 2026-06-22 · skill v2.1.0 · e4f953f24
meta: value-class=perf · pkg=@muse/cli · kind=perf · verdict=PASS · firesSinceDrill=8
ratchet: broke a 4-fire info-projection streak (14-17) → switched to perf · only change-related tests (heat policy) · muse-spec 6/6 + program.test 243/243 · root-eslint 0 · raw-ESC 0

- **What**: A pre-framework fast path for `muse spec` / `muse spec --json` (mirroring fire 5's `--version` pattern). New leaf `muse-spec.ts` (MUSE_RUNTIME_SPEC·formatSpec·trySpecFastPath); program.ts's spec action now renders via formatSpec (single source of truth, no behavior change); index.ts calls trySpecFastPath before importing program.js.
- **Why**: spec is fully static yet still paid the ~100-module graph load, 0.5s. The fast path brings it to **0.50s→0.02s (~20x)**. First-class CLI startup speed (③ perf, the lowest-latency axis). `spec --help` doesn't use the fast path → still routes through commander.
- **Review point**: output is byte-identical (text 79B·json 145B, diff 0), `spec --help` still uses the framework, mutation-first RED (a text mutation fails 1 test / mutating `runner` fails 2 including program.test — pinned to literals to avoid tautology). Sibling audit: spec's only other reference is program.test:60 (framework json), unaffected (243/243). Independent Opus ④b judge PASSED (8/8).
- **Risk**: low. Diff spans 4 files (2 src wiring + 1 new + 1 test). A single source of truth for the data means 0 drift.
- lesson: comparing `formatSpec===const` within the same file is tautological (a mutation changes both sides at once → stays green) — output text must be pinned as a **literal** in the test to get a real RED. Mutation-first caught this.
- live: `node dist/index.js spec` (0.02s) / `spec --json` (0.03s) output is byte-identical to the framework version; `spec --help` shows normal usage.
- reference: instant-start CLI conventions like gh/starship (a trivial probe avoids full init); reuses the internal fire 5 `muse-version.ts` pattern.

## fire 19 · 2026-06-22 · skill v2.1.0 · fea987e47 (JUDGE-DRILL)
meta: value-class=error-guidance · pkg=@muse/cli · kind=error-guidance · verdict=PASS · firesSinceDrill=0 (drill reset)
ratchet: switched from info-projection ×4(14-17)+perf(18) → error-guidance · unknown-subcommand 6/6 + program.test 243/243 · root-eslint 0 · raw-ESC 0

- **What**: `muse <group> <typo>` (e.g. `muse memory serch`) previously hit stock commander's dead-end `error: unknown command 'serch'` — replaced with a grounded block. New `unknown-subcommand.ts` (`formatUnknownSubcommand` pure + `attachUnknownSubcommandGuidance` wiring). Each group's commander `command:*` handler now prints `'muse <group> <attempted>'` + "Did you mean" (closest-command Levenshtein, or a unique-prefix fallback) + `Available <group> commands: <a real sorted list>`. Extends fire 7 (top-level) to subgroups.
- **Why**: typos across ~38 subgroups previously dead-ended with zero help. Provides a recovery path via a suggestion + the real list of valid subcommands (the gh/git did-you-mean convention). Grounding: both the list and the suggestion are derived from the LIVE registry (`group.commands`) — fabrication 0.
- **Review point**: the tests grade both the actual rendered string + the wiring (real commander program parse→stderr), mutation-first RED (breaking the format string fails 3-4 tests). Sibling audit: program.test 243/243 (fire 7's top-level path unaffected). When a group has its own default action (`remind`), command:* never fires → **unchanged** (no regression, a safe fallback). Independent Opus ④b judge PASSED (8/8).
- **Risk**: low. Diff spans 3 files (2 new + 1-line program.ts wiring+import). Groups with a default action keep their existing behavior.
- lesson (DRILL): injected a deliberately bad slice (a fabricated hardcoded 'show' + a tautological `typeof===string` test + unwired dead code) → the independent verifier FAILed it on all 4 rules (behavioral/mutation-RED/fabrication/wiring) → rolled back → the real grounded fix PASSED. Proves the gating verifier isn't a rubber-stamp (bidirectional calibration).
- live: `memory serch`→"Did you mean 'muse memory search'?"+a real list; `calendar evnts`→suggests events; `memory show` (valid) exits 0 normally; `memory s` (ambiguous) shows the real list with no suggestion.
- reference: git/gh "did you mean" + listing valid subcommands convention; reuses the internal fire 7 top-level unknown-command pattern.

## fire 20 · 2026-06-22 · skill v2.1.0 · 558650c96
meta: value-class=first-screen · pkg=@muse/cli · kind=first-screen · verdict=PASS · firesSinceDrill=1
ratchet: switched from info-projection(14-17)+perf(18)+error-guidance(19) → first-screen · command-groups 5/5 + program.test 237 unchanged · root-eslint 0 · raw-ESC 0

- **What**: `muse --help` printed all 103 top-level commands as a flat 280-line wall → organized daily commands into ordered category headings (Chat & ask · Memory & knowledge · Planning & time · Setup & status), with the long tail (~78) still under the default "Commands:" heading at the end. New `command-groups.ts` (`COMMAND_GROUPS` an ordered list + `applyCommandGroups`: attaches commander14's helpGroup + reorders program.commands in-place to control heading order). **DECOMPOSE slice 1** (categorizing the long tail is a follow-up).
- **Why**: the #1 first-screen value — new/returning users previously couldn't find the core commands in a 280-line wall; now they're immediately visible under top headings (gh/git-style grouping). Grounding: heading members are only pulled from the LIVE registry (`program.commands.find`) — an unregistered name is skipped (fabrication 0, and an all-absent group doesn't even leave a heading).
- **Review point**: the tests grade the real helpInformation() render's heading order+member positions, mutation-first RED (breaking heading text/order fails 2 tests). Dispatch integrity confirmed (reordering doesn't affect name-based dispatch — spec/memory show/doctor still work live), the tail 78 are preserved (0 dropped), fire-2's quickstart·fire-7's unknown-command path unaffected (program.test 237). A cast bypassing commander's readonly `.commands` type is sound since it's a mutable array at runtime (judge confirmed). Independent Opus ④b judge PASSED (8/8).
- **Risk**: low. Diff spans 3 files (2 new + program.ts wiring). One cast (justified by a comment). Partial categorization, so the long tail is a follow-up.
- live: `muse --help` → Chat & ask(11)→Memory(32)→Planning(55)→Setup(73)→Commands:(90); each group is alphabetized, daily commands on top.
- reference: gh CLI/git categorized-help convention; commander14's helpGroup API (verified against node_modules types, no code copy-paste).

## fire 21 · 2026-06-22 · skill v2.1.0 · ac05edae2
meta: value-class=first-screen · pkg=@muse/cli · kind=first-screen · verdict=PASS · firesSinceDrill=2
ratchet: first-screen 2/8(20,21<6 OK) · command-groups 5/5 + program.test 237 unchanged · root-eslint 0 · raw-ESC 0

- **What**: Extends fire 20's grouping — categorized `muse --help`'s remaining long tail (74 commands still in the "Commands:" wall) into 5 additional categories (Automation & agents · Connections · Documents & analysis · Reports & history · Diagnostics) + moved onboard into Setup & status. Mechanism unchanged, only the COMMAND_GROUPS **data** was extended (applyCommandGroups already handles any count). Tail shrinks from 74→14 (the remainder is meta/system: completion/config-path/export/import/logo/maintenance/open/pattern/persona/reflections/skills/specs/tui/user).
- **Why**: fire 20 only grouped the core 29, leaving the remaining 74 still a wall — first-screen consistency was incomplete. 9 headings now let all 103 commands be navigable (gh-style). Grounding: every member comes only from the LIVE registry (89 cross-checked, fabrication 0, 0 cross-group duplicates — guarded by a uniqueness test).
- **Review point**: the tests grade the real helpInformation() render's 9-heading order, mutation-first RED (a disjoint rename → indexOf -1, reversing COMMAND_GROUPS → out-of-order positions; a superstring rename is a known indexOf-substring limitation but catches the 2 realistic breakage classes). Dispatch integrity confirmed (spec/proactive --help/memory show work normally), program.test 237 unchanged. Independent Opus ④b judge PASSED (8/8).
- **Risk**: low. Diff spans 2 files (data+test). The categorization is subjective but grounded+unique. The 14 meta commands are honestly left under Commands:.
- live: `muse --help` → the 9 headings in order (Chat&ask 11→…→Diagnostics 229→Commands: 258), tail down to 14, onboard→Setup&status.
- reference: gh CLI category-help convention; reuses fire 20's mechanism (no code copy-paste).

## fire 22 · 2026-06-22 · skill v2.1.0 · 749fed5cf
meta: value-class=empty-state · pkg=@muse/cli · kind=empty-state · verdict=PASS · firesSinceDrill=3
ratchet: empty-state (first since fire 6) → broke a 4-info-projection·2-first-screen streak · commands-objectives 11/11 · root-eslint 0 · raw-ESC 0

- **What**: `muse objectives list` printed a barren dead-end "No objectives." in the empty state → replaced with `No objectives yet. Register one with \`muse objectives add "watch the deploy until it is green"\`.` The JSON mode (`--json`) still leaks no friendly text (clean machine output preserved).
- **Why**: a new user hitting an empty command with no "how do I start?" was a dead end → now points at the next action (a real `muse objectives add <spec...>`). Consistent with the good models already present (contacts/skills/feeds "No X. <next>"). Grounding: `muse objectives add` is real (verified via --help), fabrication 0.
- **Review point**: sibling-audited and updated 3 existing behavioral tests (run()→stdout .toBe: 50/137 assertions + 144 JSON-guard), mutation-first RED (reverting to the terse message fails 2 tests). The JSON branch returns before the empty-state text (0 leakage). Sibling barren states (episode/checkins/commitments) recorded in backlog. Independent Opus ④b judge PASSED (8/8).
- **Risk**: low. Diff spans 2 files. 1 message line+3 test sites. JSON path unchanged.
- live: `objectives list --user nobodyxyz` → the action message; `--json` → {objectives:[],total:0} with no friendly text.
- reference: gh/charm's "next action" empty-state convention; reuses the internal contacts/skills/feeds action-bearing empty-state model.

## fire 23 · 2026-06-22 · skill v2.1.0 · bce22a366
meta: value-class=info-accuracy · pkg=@muse/cli · kind=info-projection · verdict=PASS · firesSinceDrill=4
ratchet: info-projection 3/8(16,17,23<6 OK) · program.test 238/238 · root-eslint 0 · raw-ESC 0

- **What**: `muse status` printed `model: ollama/gemma4:12b (inferred from GEMINI_API_KEY)` even with local-only ON (the default) — this is **false** (per architecture.md: with local-only on, resolveDefaultModel ignores cloud keys and returns the local default). Contradicted the privacy line right below it and would alarm a privacy-conscious user. Fix: aligned `resolveModelInfo` with doctor's modelEnvCheck — with local-only on, never attribute the model to a cloud key; instead show `(local-only default — <KEY> ignored)` (when a stray cloud key exists).
- **Why**: a **fabrication-floor violation** (false information) on the marquee first screen. doctor was already correct (commands-doctor-checks.ts:72-90 + test 414) but status was a mismatched sibling. Grounding: derives posture from the single source of truth `evaluateLocalOnlyPosture(merged).enabled` (same as status's privacy line·doctor).
- **Review point**: the new test grades both status --json + the render (local-only ON+GEMINI → modelInferredFrom undefined·"local-only default — GEMINI_API_KEY ignored"·NOT "inferred from"), mutation-first RED (gating with if(false) fails). Sibling audit: the existing local-only=false inference tests (program.test 7790/7806) unaffected (238/238), `modelLocalOnlyIgnoredKey` is additive. Independent Opus ④b judge PASSED (8/8, live-verified both directions).
- **Risk**: low. Diff spans 2 files. The local-only=false path is unchanged. The new field is additive (no impact on jq consumers).
- live: `GEMINI_API_KEY=x status` (local-only ON) → "(local-only default — GEMINI_API_KEY ignored)"; `MUSE_LOCAL_ONLY=false` → "(inferred from GEMINI_API_KEY)" preserved.
- reference: the internal doctor modelEnvCheck (the correct sibling) + architecture.md's local-only rule.
