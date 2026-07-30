# @muse/a2a

Owns Muse's Agent2Agent (A2A) protocol surface: signed peer-to-peer envelopes, the discovery
`AgentCard`, and the inbound handler that lets another Muse instance (or an A2A-compatible peer)
send and receive requests. It is a package rather than a folder because the wire format, signature
verification, and quarantine-on-receive discipline must be identical for every inbound and
outbound A2A message, regardless of caller.

## Public surface

- `createPeerRegistry`, `loadPeerConfig`, `A2APeer`, `PeerConfig` — known-peer registry and its
  config loader.
- `canonicalizeEnvelope`, `signEnvelope`, `verifySignature` — envelope canonicalization and
  signature signing/verification.
- `buildMuseAgentCard`, `A2AAgentCard`, `A2AAgentSkill`, `MUSE_A2A_PROTOCOL_VERSION` — Muse's A2A
  discovery card, including the `KNOW_HOW_ONLY_EXT_URI` extension.
- `envelopeToA2AMessage`, `envelopeToSendRequest`, `extractEnvelopeFromA2ABody` — conversion
  between Muse's internal envelope and the A2A wire message/send-request shapes.
- `sendToPeer`, `receiveFromPeer`, `A2A_SIGNATURE_HEADER` — the signed HTTP transport to/from a peer.
- `receiveAndQuarantine` — lands an inbound A2A payload into quarantine before it is trusted.
- `createA2AHandler`, `AGENT_CARD_PATH`, `A2AHandlerOptions` — the server-side inbound request
  handler and its well-known agent-card path.
- `buildCouncilRequest`, `parseCouncilRequest`, `signCouncilRequest`, `verifyCouncilRequest`,
  `requestCouncilReasoning`, `COUNCIL_METHOD` — the council-reasoning sub-protocol layered on A2A.

## Depends on

- `@muse/agent-core` — the agent run an inbound A2A request ultimately triggers.

## Rules that bind this package

Inbound A2A payloads are untrusted tool/network input per
[`../../CLAUDE.md`](../../CLAUDE.md)'s "tool output is untrusted" rule — `receiveAndQuarantine`
exists so a peer's message is quarantined before it can influence agent state, and every envelope
must pass `verifySignature` before it is trusted. `agent-core` stays model-agnostic per
[`../../.claude/rules/engineering/architecture.md`](../../.claude/rules/engineering/architecture.md); this package must
not assume a specific model provider is on the other end of a peer connection.

## Tests

```bash
pnpm --filter @muse/a2a test
```
