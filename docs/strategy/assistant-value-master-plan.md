# Assistant-Value Master Plan — 2026-07-13

Origin: a 5-lens fable5 audit of Muse's system prompt and product, commissioned to
answer three questions: (1) is the system prompt at/above openclaw+hermes level,
(2) beyond security, does Muse perform its *assistant value* well — disposition,
AX, personalization, (3) can we answer "so what can you actually DO with Muse?"
and does self-improvement really work like hermes. Every finding below is
code-grounded (file:line in the source reports) and framed **model-agnostic** —
Muse must be top-tier on any model plugged in (small local → frontier cloud), not
tuned for gemma4.

## The one-line diagnosis

**Muse is a deep, well-engineered product whose value is hidden.** The machinery
(deterministic register/brevity/mirror layers, grounded proactivity, a real
self-improvement loop, 102 commands, working actuators/channels) is at or above
openclaw/hermes. What loses is **surfacing and defaults**: placeholder prompts on
the flagship surface, learned personalization demoted on live surfaces, a
self-description that covers ~5% of the product, and self-improvement that ships
half-off behind opt-in flags. Engine: a Ferrari. State: parked with the cover on.

## Four seams where value leaks

1. **Prompt quality** — the flagship `chat` surface role was a dev placeholder
   (`"(agent runtime)…"`); the `ask` role asserted a wrong engine (`via local
   Qwen`, a model-agnostic violation); the default personality layer never runs
   on a fresh install; the empty-memory `/api/chat` path carried no abstention
   line. (Lenses A, B)
2. **Personalization on live surfaces** — `buildMusePersona`'s rich learned model
   (vetoes absolute, caution marks) reaches only the CLI. Web/Telegram get
   `renderUserMemorySection`, which says "treat as soft hints, not directives"
   (inverting the veto contract), keeps the OLDEST N entries (`.slice(0, max)` —
   drops newly-learned facts), and strips vetoes/caution-marks. "Learns you"
   is betrayed exactly where a phone user lives. (Lens C)
3. **Value legibility** — ~80% of the "what can you do?" problem. Every
   self-description surface (`META_RESPONSE`, desktop meta, `--help`, onboarding,
   demo) describes only the notes-citation slice; Telegram has no meta path at
   all. The product grew 10× while the static strings froze. (Capability audit)
4. **Self-improvement defaults** — the loop is REAL and more honestly verified
   than hermes (live cross-session A/B, 0-false-contradict decay, 563 tests + 13
   live cases green), but unattended decay/consolidation, preference inference,
   and episodic capture all ship behind `MUSE_SELFLEARN_ENABLED`/flags default
   OFF. hermes's edge is DEFAULTS, not machinery. (Self-improvement audit)

## Tiered plan (value-ranked; shipped items marked)

### Shipped this session
- ✓ Injection provenance S1–S3 (deterministic source→sink taint on outbound-send
  + execute actuators — a wedge no rival has).
- ✓ Drift-gate blind-spot fix (mixed EN+KO identity strings now caught;
  `MUSE_IDENTITY_LEAD` single-sources the channel fast-path).
- ✓ user-model gap2 S1 (learned-slot vocabulary single-sourced in `@muse/recall`).
- ✓ SURFACE_ROLES: `chat` placeholder → real assistant contract (knows-you,
  lead-with-answer, clarify-vs-assume, abstain+offer, action-confirmation echo,
  once-only anticipation); `ask` model-agnostic. (gated on the live identity
  battery staying 12/12)

### Tier 1 — highest value, answers the user's stated pains
- **T1-① Value legibility** — generate the "what can you do?" answer from the
  command manifest + armed-actuator state, grouped by job, environment-aware
  ("email: connected" vs "run `muse auth gmail`"); wire Telegram meta parity.
  Deterministic so it stays honest as the product grows.
  WHERE: `ask-fast-paths.ts` META_RESPONSE, `chat-fast-path-format.ts`,
  `command-manifest.ts`, `inbound-agent-run.ts`.
- **T1-② API/channel user-model fix** — kill "soft hints, not directives";
  `.slice(0, max)` → `.slice(-max)`; thread vetoes/goals as their own sub-lists
  and the contested/provisional/stale marks; escape memory values like the other
  surfaces. WHERE: `packages/agent-core/src/runtime-helpers.ts:~332-361`.

### Tier 2
- **T2-③ Self-improvement defaults** — default-on the SAFE daemon subset
  (contradiction decay, consolidation) with the existing probation/learning-pause
  brakes + channel notice. Prove with a correction-decay analogue of
  `verify-experience-delta.mjs`.
- **T2-④ `muse auth gmail`** — guided OAuth + refresh-token store (encrypted
  secrets store exists) to unlock the built email/triage/sync domain.
- **T2-⑤ Wire the dead default personality layer** — absent persona.md →
  `defaultPersonaLayer()` (warm/humor character) instead of `undefined`.

### Tier 3 — polish / follow-on
- Cross-domain chain v1 (conflict → propose reschedule → draft message).
- user-model gap2 S2–S4 (top-K relevance + provenance tags, style accumulator,
  honesty-wall + cross-session eval).
- Vetoes on the channel fast-path snapshot; "act on what you know" action line;
  cross-session continuity line.
- identity-core vendor-denial dedup + one calm-competence line — CAVEATED: ship
  only if the live identity battery stays green on a local AND a cloud adapter.
- Injection S3b (write-risk actuators) + S4 (exfil); help grouped by job; 3-beat
  `muse demo`; jobs-first README/onboarding.

## Non-negotiable gates (every slice)
Live identity battery stays 12/12 (MODEL_LEAK=0, SYCOPHANT=0); fabrication=0;
IMMUTABLE-CORE untouched; each prompt change verified with the lens's live probe
on the real `/api/chat`, not code-only; independent adversarial gate before ship;
model-agnostic (no change may help one model tier and harm another).
