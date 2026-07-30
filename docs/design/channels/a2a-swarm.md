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
- [x] **A2A-3 — Personal swarm, end to end.** `muse swarm share <skill>`
  (outbound, draft-first), `muse swarm serve` (inbound A2A HTTP — Agent Card +
  message/send → quarantine), `muse swarm pending | promote | reject`. Quarantine
  is execute-gated (promote → authored skill, no runnable bins). Verified by a
  LIVE socket smoke: a skill shared by one Muse lands quarantined on another and
  runs only after promotion; a forged signature is rejected over the wire.
- [x] **A2A-4 — Council, end to end.** `produceCouncilReasoning` /
  `synthesizeCouncilAnswer` (grounded — the synthesis cites only real members) +
  `council/reason` over the transport (opt-in `MUSE_A2A_COUNCIL`, signed,
  bounded compute) + `muse swarm council "<q>"`. Verified live: a 2-instance
  council (initiator + a network peer) synthesises an answer drawn from both
  real members; a forged request gets empty reasoning with NO compute.
- [x] **A2A-5 — Multi-user federation.** Covered by the same transport: an
  allowlisted peer can be a friend's Muse, not just your device. The multi-user
  safety is already enforced — per-peer HMAC signing, the allowlist, PII
  redaction, draft-first outbound, inbound quarantine, and off-by-default — so
  federating know-how with a trusted peer needs only adding them to
  `a2a-peers.json`. (A future hardening: explicit mutual-consent handshake.)
- [x] **A2A-6 — Council self-abstention (honest colony, the 5th grounded
  surface).** Opt-in `MUSE_A2A_COUNCIL_GROUNDED`: a council member grounds its
  OWN take against its OWN corpus and ABSTAINS (stays silent) when it has no
  CONFIDENT evidence for the question — the multi-agent twin of "I'm not sure",
  extending the fabrication=0 grounding invariant to the peer-DRAFT surface so an
  ignorant peer can't inject a confident-but-ungrounded opinion the synthesiser
  folds in (the classic multiagent-debate failure). Deterministic gate
  (`abstainIfUngrounded`/`produceGroundedCouncilReasoning` — CRAG retrieval
  verdict, not the stochastic 8B), purely SUBTRACTIVE (members say LESS), entirely
  LOCAL (the corpus never crosses the wire — only the abstain/speak decision
  does), no new shareable kind, inbound-inert untouched. It is the PREREQUISITE
  for richer colony learning: who SPEAKS on a question reveals who has corpus for
  it (emergent specialization / federated trust need members to first stop
  speaking when ignorant). Proven live on qwen3:8b + nomic-embed
  (`verify-council-self-abstention` in `eval:self-improving`): an off-corpus
  member abstains + is EXCLUDED from the synthesised contributors while an
  in-corpus member (the over-abstention tripwire) speaks + IS a contributor. Next:
  Signed Grounding Receipt — a contributing member attaches a tamper-evident
  receipt so the synthesiser verifies-before-fold (swarm trust, externally
  auditable).

## Tension with the identity — resolved

"Tell it everything. It can't tell anyone." is about your DATA, which still never
leaves. The swarm is OFF by default; when you opt in, only PII-free *know-how*
crosses, and only with your approval. The default guarantee is unchanged; the
swarm is a deliberate, scoped, reversible exception — and inbound can never act.
