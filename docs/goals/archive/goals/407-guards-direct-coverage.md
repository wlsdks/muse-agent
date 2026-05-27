# 407 — Direct unit coverage for the security guard factories

## Why

CLAUDE.md non-negotiable: "Guards are fail-close. Security is
deterministic code, never prompt instruction." `.claude/rules/testing.md`
mandates "direct unit tests for every export of every helper module —
no implicit-only coverage." A grep confirmed
`packages/agent-core/src/guards.ts` — six security-critical fail-close
factories (`createInjectionInputGuard`, `createPiiInputGuard`,
`createTopicDriftInputGuard`, `createLlmClassificationInputGuard`,
`createPiiMaskingOutputGuard`,
`createSystemPromptLeakageOutputGuard`) — had **no direct test**:
the only references were indirect, via `agent-runtime.test.ts`
(integration of the whole runtime). A future refactor that silently
weakened a guard's fail-close direction (e.g. flipped a default,
dropped a `code`, mis-wired the classifier request) would not be
caught by the runtime test alone. This is exactly the implicit-only
coverage the rule forbids, in the highest-stakes module in the
package.

(Step-8 anti-concentration note: the recent ~13 iterations clustered
in objectives/autonomy/CLI. I first probed a genuinely different
area — whether the agent reply path leaks `<think>` from the
mandated qwen3 model — and found it already robustly stripped in
BOTH model adapters (stream + non-stream), so hardening there would
have been gold-plating. The guards gap is a distinct, real
SAFETY-area coverage hole, not low-value churn.)

## Slice

- `packages/agent-core/test/guards.test.ts` — 13 deterministic
  cases, one block per export, each pinning the fail-close contract:
  - input guards: `{allowed:true}` on clean input;
    `{allowed:false, code:<CODE>, reason}` with the exact code on a
    violating input (`INJECTION_DETECTED` / `PII_DETECTED` /
    `TOPIC_DRIFT` / `LLM_CLASSIFICATION_BLOCKED`);
  - `createLlmClassificationInputGuard`: an injected fake provider
    (no real LLM — deterministic) returning `action:allow` / `block`;
    also pins the request contract (forwards `model`, `temperature:0`,
    a **user-only** message — a system message must not leak into the
    classifier prompt);
  - `createPiiMaskingOutputGuard`: `{action:"allow"}` clean;
    `{action:"modify"}` with the raw value redacted on a PII leak;
  - `createSystemPromptLeakageOutputGuard`: `{action:"allow"}`
    clean; `{action:"reject", code:"SYSTEM_PROMPT_LEAKAGE"}` on both
    a default leakage pattern and a configured canary token.

## Verify

- `@muse/agent-core` `vitest run test/guards.test.ts`: 13/13.
- Full package suite green (585 tests, 48 files); tsc strict clean;
  `pnpm lint` 0/0; `pnpm guard:core` clean; byte-scan clean.
- Test-only, single-package, no `src` change, no request/response
  (LLM) path touched — the narrowest useful gate (per
  `.claude/rules/testing.md`); no `pnpm check` / `smoke:live`
  scale-up applies. The classifier guard is exercised with an
  injected fake, so no real-LLM round-trip is involved.

## Status

Done. The six fail-close security guards now have direct
behavior-pinning tests; a refactor that weakens any guard's
allow/block direction or drops its structured `code` now fails a
narrow, fast test instead of slipping past integration coverage.

No OUTWARD-TARGETS flip and no CAPABILITIES line: this is
coverage-hardening of an existing capability under the testing
rule, not a new user-exercisable surface — recorded honestly as a
`test(agent-core):` change, same honesty discipline as goals
404/405/406 (genuine work, no false metric).

## Decisions

- Imported from `../src/guards.js` directly (not the `index.js`
  barrel) so this is a true module-level unit test of the file's
  own exports, as the testing rule intends.
- The LLM-classification guard is tested with an injected fake
  `provider.generate` returning fixed JSON — deterministic, no
  cloud/Ollama dependency — and additionally pins that only the
  user message reaches the classifier (a system message must not
  contaminate the safety classification).
- Probed a different area first (model `<think>` leakage) and found
  it solid — avoided gold-plating, same probe-before-acting
  discipline as goals 401/403/406; then chose the highest-leverage
  real gap.
