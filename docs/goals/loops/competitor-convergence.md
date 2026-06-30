# Loop journal — competitor convergence ("내실 다지기")

> ⛔ **THEME STATUS: CONVERGENCE EXHAUSTED (confirmed fire 2, 2026-07-01).** THREE independent thorough
> scouts — headline capabilities (fire 1), fine-grained mechanisms (fire 1), and 6 cross-cutting
> dimensions (fire 2) — all landed on "Muse is mature vs openclaw + hermes." Every both-have ∩
> Muse-lacks gap is shipped (PTC · SecretSource · MCP supply-chain audit). **Future fires: do NOT
> re-dispatch a full Opus scout — read this banner, do a cheap delta-check (did a competitor add
> something NEW since 2026-07-01? `git -C /Users/jinan/ai/openclaw log` / hermes since then), and if
> nothing new, record a one-line "still exhausted" fire + end. Re-pointing the loop to a frontier axis
> (continuous-personal-learning surfacing · multi-agent orchestration reliability · grounded≠true
> misgrounding) or stopping it is Jinan's call (surfaced via PushNotification fire 2).**


Theme: each fire ANALYZES openclaw (/Users/jinan/ai/openclaw, TS, MIT) + hermes-agent
(/Users/jinan/ai/hermes-agent, Python, MIT/Apache) to find the next genuine CONVERGENCE gap
(a capability BOTH built independently = essential signal) that Muse LACKS, then BUILDS it. If a
capability is mid-build (phases incomplete below), CONTINUE it instead of scouting a new one.
Tier1 (local commits, no push). Reference patterns only — verbatim copy forbidden, cite source.

## SHIPPED / already-have (do NOT re-propose — verified by prior convergence analysis + builds)
- Programmatic Tool Calling (run_tool_plan) — branch feat/programmatic-tool-calling (hermes code_execution analogue). DONE.
- SecretSource (read secrets from the user's local vault: keychain/env + redaction + scoping) — branch feat/secret-source (openclaw secrets/ + hermes secret_sources analogue). DONE.
- MCP supply-chain static vetting (auditMcpServerConfig + fail-close gate at McpManager register/connect) — fire 1. DONE.
- Already-have (convergence analysis): MCP-server-expose, memory consolidation/dreaming, plugin↔MCP+skills, connectors, agent loop, sub-agent orchestration, policy/approval, sessions, context compression, observability+hooks, model routing/catalog, prompt/exemplar few-shot, scheduling, resilience, ACP/A2A, web/browser, tool-arg coercion, encryption-at-rest, cross-session history search, user-model slots.
- Muse's MOAT (both competitors LACK): the deterministic grounding/citation/fabrication=0 gate. Not a gap.
- Weak/low-conviction convergence (defer unless a real need): MITM traffic-capture proxy (weak convergence + local-only tension).

## Capabilities in progress
(none — MCP supply-chain audit shipped fire 1; next fire scouts)

## Fire log
(appended per fire)

## fire 1 · 2026-07-01 · (commit pending judge) · MCP supply-chain static vetting
verdict: PASS (re-judge PASS after fixes + full pnpm check 0) · the ONE genuine convergence gap (a FINE pass confirmed Muse is otherwise mature)
- WHAT: `auditMcpServerConfig(server) -> {safe, reasons}` (packages/mcp/src/server-audit.ts) — a PURE, LOCAL, deterministic static scan of an stdio MCP server's command/args/env for dangerous launch patterns (download-and-exec `curl|sh`, reverse shell `/dev/tcp`·`nc -e`, inline-code exec `child_process`/`-e`/`-c` bodies, command-substitution/metacharacters, suspicious temp/hidden-dir binaries, env exec). Wired fail-close at McpManager.register AND connect (mirrors the name-allowlist disable path) — a failing server is DISABLED + never connected, no throw.
- WHY (convergence): openclaw `security/audit.ts`+`audit-deep-code-safety.ts` and hermes `osv_check.py`+`skills_ast_audit.py` BOTH statically vet external extension code before execution — a real supply-chain layer Muse lacked (it gated MCP by NAME only). Fits "security is deterministic fail-close code" (a Muse non-negotiable).
- REVIEW: 21 tests — 9 dangerous patterns blocked, **9 legit shapes (npx scoped/-y, uvx, node, python -m, docker, env with `&`/secrets) audit SAFE = the #1 false-positive risk addressed**, remote-transport safe, 3 gate tests (connector NEVER called for a dangerous server) + mutation RED (gate ignores verdict ⇒ test RED) + full @muse/mcp 795 + 0 TS + lint 0.
- RISK / deferred: a v1 static scanner has evasion gaps (obfuscated launch lines) — acceptable defense-in-depth, not the sole gate (the allowlist + runner sandbox remain). Live OSV advisory feed (network ⇒ opt-in/offline) + per-tool AST audit deferred. Skill-body scan N/A (Muse skills are self-authored).
- JUDGE CAUGHT 4 real issues (maker≠judge working — the happy-path build PASSed the builder's own tests but the independent Opus judge + re-judge found): (1) FALSE-BLOCK — the hidden-dir heuristic blocked legit project-local servers (`node_modules/.bin/<srv>`, `~/.config/...`, `.vscode/...`); a security gate that breaks normal `npx`/local MCP is worse than useless. FIX: removed the hidden-dir rule, flag ONLY world-writable temp (`/tmp`,`/var/tmp`,`/dev/shm`). (2) BYPASS — `python3 -c`/`perl -e`/`ruby -e`/`node -e` audited SAFE (classic RCE launch lines). FIX: SCRIPT_INTERPRETERS + INLINE_CODE_FLAG (`-c`/`-e`/`--eval`), `-m` module stays safe. (3) BYPASS (re-judge) — `env python3 -c` wrapper evaded the commandBase check. FIX: `unwrapEnvWrapper` peels one `env` layer (skips opts + NAME=VALUE) before the interpreter/path check. (4) REGRESSION — the new rule (correctly) flagged the apps/api integration test's `node -e <fixture>` launch. FIX: the test now writes the fixture to a temp `.mjs` FILE inside packages/mcp (so its bare SDK imports resolve) and runs `node <file>` — the realistic server shape; the gate stays strict.
- REVIEW: 801 @muse/mcp tests (9 dangerous incl. interpreter + env-wrapper, 13 legit-SAFE incl. node_modules/.bin + env-module, gate tests connector-never-called) + 3 mutation drills RED (gate-ignores-verdict, interpreter-rule-off, env-unwrap-off) + apps/api mcp integration green + FULL pnpm check exit 0 (35 suites) + lint 0 + independent Opus judge: FAIL→fix→re-judge PASS.
- NOTE: this is likely the LAST clear convergence gap — the fine scout confirmed Muse is mature vs both rivals (PTC + SecretSource + this close the "both-have ∩ Muse-lacks" set). Next fires may honestly report vein exhaustion.

lesson: a security gate's two failure modes (false-block legit · miss a bypass) BOTH need an adversarial judge — the builder's own 21 happy-path tests PASSed while the gate would have broken every project-local MCP server AND let `python3 -c` RCE through. And a strict new gate WILL surface a real regression in existing tests that used the now-flagged shape (node -e fixtures) — fix the test to the realistic shape, don't weaken the gate.

## fire 2 · 2026-07-01 · (journal-only) · CONVERGENCE VEIN EXHAUSTED (3rd independent confirmation)
verdict: no build slice — honest exhaustion, NOT make-work (the loop's "할 게 없다 금지"는 *스카웃을 더 하드하게*가 아니라 정직히 종료하라는 뜻; 억지 갭 금지).
- DID: cleared the in-progress section (MCP audit shipped fire 1); ran a THIRD scout at a fresh angle — 6 cross-cutting DIMENSIONS (resilience · data-handling · observability · operator affordances · safety guardrails · eval infra) that the two prior capability-focused scouts didn't target.
- FOUND: every both-have mechanism Muse ALREADY has, freshness-guarded by name: loop/circuit-breaker (tool-loop-progress.ts/tool-failure-streak.ts/tool-call-deduplicator.ts, arXiv-grounded) · state-migration (db/migrations.ts + per-store schemaVersion) · resume-replay + `muse why` + action-log · `muse doctor` + Zod config · SSRF (web-url-guard.ts, IPv4+IPv6+CGNAT+metadata) · output-size cap (tool-output-summary.ts — its header already cites hermes) · eval infra (eval:tools/judge/adversarial/plan-quality + self-eval scoreboard, the deepest of the three). TWO Muse files explicitly cite the competitor/arXiv as reference — Muse absorbed these patterns deliberately, not by coincidence.
- CONCLUSION: the convergence surface between Muse and openclaw+hermes is genuinely CLOSED. 3 independent passes ⇒ this is a robust finding, not a missed scout.
lesson: a maturity verdict needs MULTIPLE independent angles (capability · mechanism · cross-cutting dimension) before it's trustworthy — one scout can miss, three converging is signal. When a THEME (not just a vein) is exhausted, the honest move is to record it loudly + surface a re-point to Jinan async (PushNotification) + make future fires CHEAP (a banner the next fire reads to avoid re-burning an Opus scout) — never manufacture a gap to keep the loop "busy".
