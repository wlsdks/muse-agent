# Agent-development principles — 2026 field survey vs. Muse

2026-07-13, three parallel research passes (official vendor guidance /
security / operations), primary sources only. Purpose: which of the
field's converged principles Muse already encodes as code+rules, and
which are genuinely missing. Companion to `.claude/rules/*.md` (the
enforced form) and `context-doctrine.md` (the research ledger for the
context axis).

## The converged principles (stated by 2+ independent primary sources)

1. **Simplicity first — workflows before agents.** Only add agentic
   complexity when it demonstrably improves outcomes. (Anthropic
   building-effective-agents; OpenAI practical guide; Google ADK.)
2. **Tool design clarity beats prompt cleverness.** Descriptions
   written like onboarding a new teammate; the "intern test"; no
   redundant params; small tool sets (OpenAI: <20, higher accuracy);
   clear namespacing; high-signal returns (names over UUIDs).
   (Anthropic writing-tools; OpenAI function-calling; Google ADK.)
3. **Context is a finite resource with a cache.** Stable deterministic
   prefixes, append-only growth, one boundary; mask/summarize stale
   observations instead of deleting tools mid-session; just-in-time
   retrieval over pre-loading; compaction near limits. (Anthropic
   context-engineering; Manus; Chroma context-rot.)
4. **Grade outcomes, not paths; evals from real failures; three grader
   types** (deterministic → model → human), 20–50 realistic tasks to
   start, owned as a living artifact. (Anthropic demystifying-evals;
   τ-bench lineage.)
5. **Security is enforced outside the model's reasoning loop.**
   Deterministic policy engine intercepting actions (Google L1), OWASP
   "complete mediation", Anthropic "supervise capability, not
   behavior" (sandbox/egress/mounts). Never prompt-based.
6. **Least privilege, task-scoped and time-bound.** Minimize
   extensions/functionality/permissions (OWASP LLM06); short-lived
   narrowly-scoped tokens (ASI 2026); risk-rate every tool on
   read/write/reversibility (OpenAI).
7. **The lethal trifecta must be broken architecturally.** Private
   data + untrusted content + external communication = exploitable;
   detection guardrails at "95%" are a failing grade — remove a leg
   (egress control is the practical one). (Willison; Anthropic
   how-we-contain-claude.)
8. **Once untrusted input is ingested, consequential actions must be
   impossible.** The six design patterns (Action-Selector,
   Plan-Then-Execute, LLM Map-Reduce, Dual LLM, Code-Then-Execute,
   Context-Minimization) all freeze plan/privileges BEFORE the
   untrusted read. (Willison / DeepMind-et-al design-patterns paper.)
9. **Human approval for consequential actions — designed against
   approval fatigue.** Anthropic measured ~93% approval rates (rubber-
   stamping); the fix is pre-defined safe boundaries + auto-approval
   classifiers, not more prompts. Pause specifically before side
   effects; put validation next to the tool that creates the side
   effect. (Anthropic; OpenAI guardrails docs; Google "human control".)
10. **Model/tool output is untrusted input downstream.** Validate/
    encode before it reaches shells, SQL, other tools (OWASP LLM05);
    layered guardrails, single guardrail insufficient (OpenAI).
11. **Multi-agent: coordination is the failure mode, not capability.**
    Share full traces not messages (Cognition); structured delegation
    with explicit boundaries prevents duplicate work (Anthropic
    multi-agent); top MAST failures are step repetition,
    reasoning-action mismatch, unaware-of-termination.
12. **Durable execution: checkpoint + idempotent tools + resumable
    state.** Retries distinguish transient from permanent; escalate
    permanents to humans. (OpenAI persist-state; Google decouple-state;
    Inngest/industry.)
13. **Observability & provenance of every action.** Log decisions,
    tool calls, outcomes; audit trails are now compliance artifacts
    (EU AI Act 2026). (Google; OWASP cheat sheet.)
14. **Memory needs governance at launch.** Scope writes (user/agent/
    session), validate memory writes (poisoning is ASI06/T1), retention
    and deletion policies are architectural, not retrofittable.
    (OWASP ASI; Mem0; Konishi.)

## Muse scorecard

Already encoded (rule/code that enforces it): #1 (CLAUDE.md scope
discipline), #2 (`tool-calling.md` — one-shot selection on a 12B model
made it existential, not stylistic), #3 (`context-doctrine.md`:
MUSE_CACHE_BOUNDARY, observation masking, edge-placement, span
retention), #4 (`agent-testing.md`: outcome-state tests, pass^k, three
grader layers, eval:agent CI), #5 (Non-negotiable "security is
deterministic code, never prompt instruction"; grounding/citation gates
post-generation), #10 (tool-output sanitizer, injection patterns,
untrusted tool output rule), #11 (MAST-based asserts in
`agent-testing.md`; orchestration evals), #12 (per-tool checkpoints +
dedup-seeded resume; retry classification fail-fast on 4xx), #13
(action log with rationale, sent AND refused), #14 (correction-decay,
encrypted stores, veto/undo; single-user so scope tags are mostly
moot).

Partially encoded / genuine gaps (candidate slices, strongest first):

- **#7 exfil leg (GAP)**: `outbound-safety.md` gates *sends*, and
  MUSE_LOCAL_ONLY gates *model* egress — but a plain `web_fetch`/browse
  GET is external communication too (Willison counts any HTTP request:
  `attacker.com/?q=<private-data>` exfiltrates via a "read"). With
  injection-provenance taint now tracked at write sinks, the same taint
  should gate NETWORK sinks: untrusted content in context ⇒ fetches
  restricted to an allowlist / stripped of context-derived params.
- **#8 freeze-before-read (PARTIAL)**: `groundedArgs` drops
  out-of-context arg tokens and the planner exists, but no deterministic
  Plan-Then-Execute mode where the tool plan locks before untrusted
  content enters. Candidate: plan-freeze flag on flows that mix
  retrieval + actuators.
- **#9 approval fatigue (UNMEASURED)**: gates exist and are fail-close,
  but Muse never measures its own approval-rate; a >90% approve-rate on
  a gate class is Anthropic's rubber-stamp signal. Candidate: track
  approve/deny per gate class in the action log + surface in
  `muse doctor`; widen pre-approved safe classes instead of adding
  prompts.
- **#6 time-bound permissions (GAP, low urgency single-user)**: consents
  (`performConsentedAction`) are scoped but not time-bound; no expiry on
  standing consents. Candidate: TTL on recorded consents.
- **#2 namespacing (MINOR)**: verb_noun enforced; no explicit
  family-prefix rule for related tools — worth one line in
  `tool-calling.md` next time tools multiply.

Non-adoptions (deliberate): USER.md-style hand-written fact files
(D2 — ungroundable citation source); multi-agent-by-default (Cognition's
warning matches Muse's single-model reality); per-action approval for
everything (fatigue evidence above).

## Sources

Vendor: Anthropic building-effective-agents · claude-agent-sdk ·
writing-tools-for-agents · effective-context-engineering ·
demystifying-evals · multi-agent-research-system · how-we-contain-claude;
OpenAI practical-guide-to-building-agents · function-calling ·
agents/guardrails docs; Google ADK single-agent architecture ·
secure-AI-agents paper. Security: OWASP LLM Top-10 2025 · Agentic
Threats & Mitigations 2025 · Agentic Top-10 2026 · AI-Agent cheat
sheet; Willison lethal-trifecta · prompt-injection design patterns.
Ops: Manus context-engineering; Cognition dont-build-multi-agents;
MAST arXiv:2503.13657; Mem0 memory survey; Inngest durable execution.
