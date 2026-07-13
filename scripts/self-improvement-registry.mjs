/**
 * THE SELF-IMPROVEMENT REGISTRY — one table, the single source of truth for every
 * surface through which Muse learns.
 *
 * Why this exists. Twice in one day a learning surface was found DEAD in
 * production while every test was green: playbook credit assignment fired on 3 of
 * 13 real corrections, and the decay gate had NEVER fired since it shipped. Both
 * were found by ad-hoc measurement — nothing in the repo would have caught them,
 * and nothing would catch the next one. A unit test proves a function is correct;
 * it does not prove the function is REACHED, or that its gate is on, or that it
 * does anything on real input.
 *
 * So every learning surface must declare, here, four things:
 *
 *   entry     — the function that does the learning (file + exported symbol)
 *   firesFrom — WHO calls it in production, in one phrase. If you cannot name a
 *               caller, the surface is inert and does not belong in the product.
 *   gate      — the env flag and its DEFAULT. `null` means always on.
 *   liveProof — the battery that proves it actually fires on real input, and that
 *               is wired into `eval:self-improving` so it runs.
 *
 * `scripts/self-improvement-guard.test.mjs` enforces all four: the entry must
 * exist and be exported, the gate default in the code must match what is claimed
 * here, and the proof must exist and be registered in the release gate. Adding a
 * new learning surface therefore means adding a row here and a live proof — and
 * the guard tells you the moment you forget.
 */

export const SELF_IMPROVEMENT_SURFACES = [
  {
    surface: "teaching-signal capture (EVERY surface)",
    what: "A correction or redirect you make anywhere — web, Telegram, API, chat — is queued as a lesson.",
    entry: { file: "packages/agent-core/src/correction-capture-hook.ts", symbol: "createCorrectionCaptureHook" },
    firesFrom: "an afterComplete hook on the AgentRuntime, so every surface that runs an agent captures",
    gate: { env: "MUSE_PLAYBOOK_DISTILL_ENABLED", default: true },
    liveProof: "apps/cli/scripts/verify-playbook-merge.mjs"
  },
  {
    surface: "correction → strategy (session end)",
    what: "A correction you make in chat becomes a learned strategy on probation.",
    entry: { file: "apps/cli/src/chat-distill-corrections.ts", symbol: "distillSessionCorrections" },
    firesFrom: "the end-of-session pipeline, on every interactive chat",
    gate: { env: "MUSE_PLAYBOOK_DISTILL_ENABLED", default: true },
    liveProof: "apps/cli/scripts/verify-playbook-merge.mjs"
  },
  {
    surface: "credit assignment (which rule your feedback is about)",
    what: "Decides WHICH learned strategy a piece of feedback reinforces or contradicts.",
    entry: { file: "packages/agent-core/src/correction-distiller.ts", symbol: "selectCreditTargetLlm" },
    firesFrom: "distillSessionCorrections, for every approval/correction cue in the session",
    gate: null,
    liveProof: "scripts/eval-playbook-credit.mjs"
  },
  {
    surface: "correction-decay (retiring a rule you contradicted)",
    what: "A new correction that contradicts an applied strategy drops it below the inject line.",
    entry: { file: "packages/autoconfigure/src/decay-contradicted.ts", symbol: "decayContradictedStrategies" },
    firesFrom: "the daemon self-learn tick, and the session-end distill",
    gate: { env: "MUSE_SELFLEARN_ENABLED", default: true },
    liveProof: "apps/cli/scripts/verify-correction-polarity.mjs"
  },
  {
    surface: "strategy injection (a learned rule reaching the model)",
    what: "A graduated strategy is ranked and rendered into the system prompt.",
    entry: { file: "packages/agent-core/src/playbook-injection.ts", symbol: "applyPlaybook" },
    firesFrom: "the AgentRuntime, on every run with a playbook provider",
    gate: { env: "MUSE_PLAYBOOK", default: true },
    liveProof: "apps/cli/scripts/verify-experience-delta.mjs"
  },
  {
    surface: "user-memory auto-extract (facts / preferences / vetoes / goals)",
    what: "Extracts what you revealed about yourself from each exchange.",
    entry: { file: "packages/memory/src/memory-auto-extract.ts", symbol: "createUserMemoryAutoExtractHook" },
    firesFrom: "an afterComplete hook on the AgentRuntime, every turn",
    gate: { env: "MUSE_USER_MEMORY_AUTO_EXTRACT", default: true },
    liveProof: "apps/cli/scripts/verify-preference-inference.mjs"
  },
  {
    surface: "skill authoring / review",
    what: "Recurring work becomes a reusable skill.",
    entry: { file: "packages/agent-core/src/skill-review.ts", symbol: "reviewSkillsFromTurns" },
    firesFrom: "the background-review hook on the AgentRuntime",
    gate: { env: "MUSE_SKILL_AUTHOR_ENABLED", default: true },
    liveProof: "apps/cli/scripts/verify-background-review.mjs"
  },
  {
    surface: "skill merge (consolidating near-duplicate skills)",
    what: "Overlapping skills collapse into one umbrella skill.",
    entry: { file: "packages/agent-core/src/skill-merge.ts", symbol: "mergeSkillsIntoUmbrella" },
    firesFrom: "the daemon consolidation tick",
    gate: { env: "MUSE_SELFLEARN_ENABLED", default: true },
    liveProof: "apps/cli/scripts/verify-skill-merge.mjs"
  },
  {
    surface: "proactive pattern suggestion",
    what: "A recurring pattern in your own behaviour becomes an offer to help.",
    entry: { file: "packages/agent-core/src/pattern-suggestion.ts", symbol: "synthesizePatternSuggestion" },
    firesFrom: "the proactive daemon tick",
    gate: null,
    liveProof: "apps/cli/scripts/verify-pattern-suggestion.mjs"
  }
];
