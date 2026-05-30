# Muse A2A swarm — a network of private agents that teach each other HOW, never WHAT

> Decided 2026-05-30 (with 진안). A new functional pillar alongside the grounding
> edge: multiple Muses connect peer-to-peer (A2A) and federate KNOW-HOW, while
> every byte of personal data stays local. No competitor (hermes/openclaw is
> single-agent) has a network of *private* agents. Off by default; the swarm is
> the exception, not the posture.

## The one rule that makes it safe

**Muses share know-how (HOW), never data (WHAT).** What may cross the wire:
authored **skills**, **playbook strategies**, and **council reasoning
utterances** — procedural knowledge, PII-redacted, that you approve. What may
NEVER cross: notes, episodes, personal facts, credentials, tool calls, or any
request to run something. A received payload is inert — it lands quarantined and
execute-gated until *you* promote it; a peer can never trigger compute on your
machine.

## Safety architecture (all of it enforced in code, fail-closed)

| Guarantee | Mechanism |
|---|---|
| Off by default | `isA2AEnabled` (`MUSE_A2A_ENABLED`, fail-closed) — opt-in, like `MUSE_LOCAL_ONLY` |
| Only know-how crosses | `prepareOutbound` refuses any kind outside `{skill, strategy, council-utterance}` — a note/fact/credential isn't expressible as outbound |
| PII never leaves | outbound content `redactSecretsInText`-scrubbed before send; the envelope records `redacted` |
| Inbound is inert | `classifyInbound` returns only `quarantine | reject` — there is NO `execute` disposition |
| Received know-how is quarantined | a received skill is execute-gated like an authored skill (`AuthoredSkillStore`) until the user promotes it |
| Allowlisted peers only | unknown sender → reject; peers are an explicit allowlist (your devices / trusted friends), signed |
| Recorded + draft-first | outbound shares are draft-first (reuse `outbound-safety`); every send/receive logged |

**Status:** the deterministic safety core (`packages/agent-core/src/a2a-safety.ts`)
is built + verified (8 unit tests: opt-in fail-closed; outbound refuses
non-know-how + redacts PII; inbound quarantines valid know-how, rejects unknown
peer / non-shareable kind / malformed — never executes). This is the seam every
transport and mode routes through.

## The three modes (build order: safest → broadest)

1. **Personal swarm** (FIRST — zero third-party risk). Your own devices'
   Muses (phone · laptop · server) share authored skills/strategies over A2A.
   Proves the transport + quarantine + promote loop with no external party. Your
   laptop learns a skill your phone authored.
2. **Council** (single-user multi-instance, then opt-in peers). Several Muses
   debate ONE question agent-to-agent — exchanging *reasoning*, not corpus — and
   synthesise an answer. Data-light by construction.
3. **Multi-user federation** (LAST — needs the most ceremony). Trusted friends'
   Muses federate know-how. Adds per-peer signing, mutual consent, and the
   strictest redaction; only after the personal swarm proves the model.

## Slice roadmap (the loop chews through these, each live-verified)

- [x] **A2A-1 — Safety core.** Envelope + outbound/inbound gates, opt-in,
  redaction, inert-inbound, allowlist. `a2a-safety.ts` + 8 tests.
- [x] **A2A-2 — Transport (`@muse/a2a` package).** Peer-to-peer HTTP between
  Muse instances: `createPeerRegistry` (allowlist + per-peer shared secret),
  HMAC-SHA256 envelope `signEnvelope`/`verifySignature`, and `sendToPeer` /
  `receiveFromPeer` that route every message through the safety core
  (`prepareOutbound` / `classifyInbound`). 8 contract-faithful tests on a fake
  HTTP boundary: a skill is redacted + signed + POSTed; send refuses when
  disabled / non-know-how; receive quarantines a valid signed payload but
  REJECTS a tampered signature, an unknown peer, a disabled receiver, and a
  VALIDLY-SIGNED non-know-how kind (the safety core overrides the signature — a
  trusted peer still can't smuggle a compute/tool payload). build + lint 0/0.
- [ ] **A2A-3 — Personal swarm wiring.** `muse swarm share <skill>` (outbound,
  draft-first) + inbound quarantine into the authored-skill store (execute-gated)
  + `muse swarm pending | promote <id>`. Live: a skill authored on peer A is
  received quarantined on peer B and runs only after promotion.
- [ ] **A2A-4 — Council mode.** N Muses exchange reasoning utterances on a
  question → synthesise. Single-user multi-instance first; live battery.
- [ ] **A2A-5 — Multi-user federation.** Per-peer signing + mutual consent +
  strict redaction; deny/timeout/unconsented → no cross-share (contract test).

## Tension with the identity — resolved

"Tell it everything. It can't tell anyone." is about your DATA, which still never
leaves. The swarm is OFF by default; when you opt in, only PII-free *know-how*
crosses, and only with your approval. The default guarantee is unchanged; the
swarm is a deliberate, scoped, reversible exception — and inbound can never act.
