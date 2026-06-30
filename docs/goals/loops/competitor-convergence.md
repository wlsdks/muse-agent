# Loop journal — competitor convergence ("내실 다지기")

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
### MCP supply-chain static vetting (convergence gap: openclaw audit.ts + hermes osv_check/skills_ast_audit)
A deterministic, LOCAL, fail-close static auditor of an external MCP server's config (command/args/env)
run at McpManager register/connect — BEFORE the server is connected — alongside the existing name
allowlist. Dangerous patterns (shell download-pipe-execute, eval/`sh -c` wrappers, command-injection
metacharacters, suspicious absolute-path binaries) ⇒ server DISABLED fail-close (uncertain ⇒ refuse),
reason recorded; no exception. Local-only (pure static, no network); a network OSV advisory feed is
opt-in/offline and DEFERRED. Skill-body AST scan deferred (Muse skills are self-authored, not hub-imported).
- [x] Phase 1 — `auditMcpServerConfig(server) -> {safe, reasons[]}` pure static scanner + the fail-close
      gate at McpManager.register/connect (reuse the isServerAllowed seam) + tests (dangerous blocked,
      normal npx passes, injection trips, mutation: bypass ⇒ dangerous connects RED).

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
