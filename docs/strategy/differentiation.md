# Muse differentiation ledger — where we win vs hermes / openclaw

> The `differentiation` loop's compounding artifact. Each fire researches a
> competitor capability/claim (cited), names ONE lever where Muse wins
> **structurally** (something a rival cannot copy without breaking their own
> product), and ships a verifiable code slice widening it. Rivals:
> hermes ([nousresearch/hermes-agent](https://github.com/nousresearch/hermes-agent), MIT) ·
> openclaw ([docs.openclaw.ai](https://docs.openclaw.ai/concepts/memory), MIT) — both
> free to study; we apply published mechanisms (cited), never copy proprietary code.

## Levers (newest first)

### L6 — Safety guards are deterministic, model-independent, multilingual code over the live turn — not output-only, English-only, or a bolt-on (fire 12)

Muse's `@muse/policy` runs the SAME normalize-then-match code on every input
regardless of which model is behind it: `normalizeForInjectionDetection` folds
zero-width (incl. the U+E0000 TAG range), homoglyphs, and named/numeric HTML
entities to a canonical form, then `findInjectionPatterns` matches 50+ EN/**KO**/CN/JP/ES
patterns (credential-exfil, cross-user, skeleton-key, prompt-extraction), and
`findPii`/`maskPii` detect + **non-destructively** mask KR national-id/phone + intl
SSN/IBAN/card. So a credential-exfil an 8B model obeys in Korean but refuses in
English (a recorded language-asymmetry finding) is caught identically by code, and an
obfuscated SSN can't slip the regex — no model in the loop. Rivals are structurally
narrower: hermes's deterministic scanner is **English-focused + scoped to context
files** (its SECURITY.md says "prompt injection per se is not a vulnerability"), and
its PII redaction is output-only, off-by-default ([#17691](https://github.com/NousResearch/hermes-agent/issues/17691)),
config-ignored ([#11009](https://github.com/NousResearch/hermes-agent/issues/11009)),
and **destructive — it writes `***` into source files on disk** ([#5322](https://github.com/NousResearch/hermes-agent/issues/5322));
openclaw **outsources defense to a bolt-on** (NVIDIA NeMo Guardrails, [NemoClaw](https://ibl.ai/service/nemoclaw))
whose defenses "largely assume stateless, single-turn interactions" ([arXiv 2603.11619](https://arxiv.org/pdf/2603.11619),
[CrowdStrike](https://www.crowdstrike.com/en-us/blog/what-security-teams-need-to-know-about-openclaw-ai-super-agent/)).
A throughput/breadth cloud agent has no product reason to pay for in-core multilingual
normalize-then-match over every live turn; for a single-user "it can't tell anyone"
assistant, that the guard is deterministic code (CLAUDE.md: "security is deterministic
code, never prompt instruction") and language-symmetric IS the trust contract.

**Shipped (fire 12):** `scripts/eval-policy-symmetry.mjs` (`pnpm eval:policy-symmetry`)
— a deterministic battery (no Ollama) proving cross-language injection symmetry
(EN/KO/CN), obfuscation-defeat (zero-width / homoglyph / HTML-entity normalized then
caught), obfuscated-PII detection, non-destructive masking, and no over-block, importing
`@muse/policy`'s already-exported guards read-only. (Honest scope: proves the guard's
properties, not its wiring into every live surface — a code-property proof like L2/L4/L5.)

### L5 — Every autonomous action is sealed into a tamper-evident hash chain; silent rewrite of the agent's own history is detectable in code (fire 11)

Muse hash-chains every logged autonomous action — performed AND refused — into a
genesis-anchored SHA-256 chain (`appendActionLog` sets each entry's `prevHash` to
`computeEntryHash` of the tip; `ACTION_LOG_GENESIS_HASH` roots it). So
`verifyActionLogChain` / `verifyActionLogChainFile` (`@muse/mcp`) mechanically detect
any after-the-fact edit, deletion, reorder, or insertion and pinpoint the break
index, and `undoLoggedAction` records a durable veto + an accountable `undo_*` entry
that *extends* the chain rather than breaking it. Rivals treat their action/mutation
history as ordinary mutable state: hermes offers whole-skill snapshot/restore +
timestamped rollback ([Curator docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/curator),
[MindStudio](https://www.mindstudio.ai/blog/hermes-agent-five-pillars-memory-skills-soul-crons))
but no integrity check over the snapshot store itself; openclaw's Dreaming
`--rollback` covers only staged diary/short-term candidates, **not** entries already
promoted to MEMORY.md, and the community's request for a per-entry correction layer
([Issue #62184](https://github.com/openclaw/openclaw/issues/62184)) was closed as not
planned ([DeepWiki 7.2](https://deepwiki.com/openclaw/docs/7.2-dreaming-and-memory-consolidation)).
A cloud/throughput product has no reason to pay for a per-action hash chain, and a
"freely self-mutating skills/memory" pitch is structurally at odds with a
verifiable-immutability seam over that history — for a single-user "it can't tell
anyone, and it can't quietly rewrite what it did" assistant the chain *is* the trust
contract. (Honest scope: tamper-EVIDENT — detects partial-write / accidental /
second-process mutation — not tamper-PROOF against a motivated attacker who recomputes
the whole chain; that needs an off-box anchor, declared out of scope in source.)

**Shipped (fire 11):** `scripts/eval-action-log-tamper.mjs` (`pnpm eval:action-log-tamper`)
— a deterministic battery (real temp files, no Ollama) proving an intact mixed
performed/refused chain verifies, a content edit / deletion / reorder is caught,
refused actions are chained too, and an irreversible `undoLoggedAction` records a veto
+ accountable undo entry while keeping the chain intact (no-collateral). The mcp engine
(`personal-action-log-store.ts`, `undo-action.ts`) is imported read-only, untouched.

### L4 — The source receipt verifies the quote against the FILE ON DISK at render time, not the retrieval-index copy (fire 8)

Muse's "📎 From your notes (open to verify)" receipt (`formatSourceReceipts`,
`@muse/recall`) prints a verbatim snippet drawn from `r.chunk.text` — the
**retrieval-index copy** embedded at index time. Nothing re-confirmed that snippet
was still a real substring of the cited file *now*, so a note edited or deleted
after indexing would still get a confident verbatim quote and an "open to verify"
path pointing at text the file no longer contains — exactly the *fake citation* the
grounded-attribution literature warns about (the AIS principle: a citation is only
honest when the snippet actually supports the claim —
[Nexumo "11 Tests That Expose Fake Citations"](https://medium.com/@Nexumo_/rag-grounding-11-tests-that-expose-fake-citations-30d84140831a) ·
[arXiv 2409.11242](https://arxiv.org/pdf/2409.11242)). Rivals cite from their
embedded copy by construction: hermes's defense is an internal self-judgment
"Hallucination Gate" over its own reasoning, not a user-openable on-disk receipt
([dev.to](https://dev.to/ahmad_rrrtx/the-agent-that-writes-its-own-manual-a-deep-dive-into-hermes-agents-self-improving-architecture-58h2));
openclaw's is an operational circuit-breaker ([Wikipedia/OpenClaw](https://en.wikipedia.org/wiki/OpenClaw)) —
neither re-reads the source at render time. A throughput/breadth-pitched cloud-RAG
product has no product reason to pay that re-read; Muse is single-user,
local-by-construction, and "shows its work" *is* the product, so re-reading the
user's own local note to keep the receipt honest is cheap and on-brand.

**Shipped (fire 8):** `formatSourceReceipts` now takes an optional caller-supplied
disk-content map and, on drift, HIDES the stale quote and says why ("source changed
since indexed" / "no longer on disk") instead of vouching for it; `scripts/eval-receipt-drift.mjs`
(`pnpm eval:receipt-drift`) proves it end-to-end with real temp files (faithful
verifies, drifted + deleted are caught, no-collateral). **Slice 2 (fire 10 — LIVE):**
`buildDiskContents` (`@muse/recall`) re-reads each cited note's current content
(ad-hoc sources skipped) and `commands-ask.ts` feeds it to the receipt, so the live
`muse ask` now hides a snippet the file no longer contains ("changed since indexed" /
"no longer on disk") instead of quoting it. The fake-citation defense is user-facing.
The grounding engine (`verifyGrounding`/`enforceAnswerCitations`) is untouched.

### L3 — The embedder is fail-close localhost under local-only, not localhost-by-default (fire 4)

A latent hole in the L1 moat: `createOllamaEmbedder` (`@muse/autoconfigure`) read
`OLLAMA_BASE_URL` and POSTed the user's raw note / memory / episode text to
`${base}/api/embeddings` with **no local-only check**. The chat-model router's
`classifyProviderLocality` gate only derives `effectiveBaseUrl` from
`OLLAMA_BASE_URL` when the *chat* provider id is `ollama` — so a localhost
LM-Studio / openai-compatible chat model + a **remote** `OLLAMA_BASE_URL`
diverge: the chat gate passes while the embedder silently egresses private text,
and the daemon enrich path calls the embedder without touching the router at all.
So architecture.md's "embeddings are already localhost-only" was *false* for a
remote `OLLAMA_BASE_URL`. Fixed with a construction-time fail-close
(`MUSE_LOCAL_ONLY` default-on + non-loopback base → `throw LocalOnlyViolationError`,
reusing `@muse/model`'s `isLoopbackUrl`), a single chokepoint covering all three
embedder call sites + the daemon bypass; loopback / unset pass, `MUSE_LOCAL_ONLY=false`
preserves opt-out. A cloud-default rival sends embeddings to an external API by
design and has no structural reason to fail-close this — the same asymmetry as L1.

**Shipped:** the embedder guard (`context-engineering-builders.ts`) + 6 behavioural
tests (remote+local-only → throw AND fetch never called; loopback/opt-out pass);
the new throw site is folded into the `egressGuards` ratchet (6→7) so deleting it
fails `pnpm self-eval`.

### L2 — Memory promotion is gated on provenance at WRITE time, not frequency at PROMOTE time (fire 3)

OpenClaw's "Dreaming" consolidation promotes short-term signals into durable
`MEMORY.md` through frequency/recency threshold gates — minScore 0.8,
**minRecallCount 3**, minUniqueQueries 3, six weighted signals dominated by
Frequency (0.24) and Recency (0.15)
([docs.openclaw.ai/concepts/dreaming](https://docs.openclaw.ai/concepts/dreaming) ·
[DeepWiki 7.2](https://deepwiki.com/openclaw/docs/7.2-dreaming-and-memory-consolidation)).
Hermes curates memory via SQLite FTS5 + LLM summarization
([mudrii/hermes-agent-docs](https://github.com/mudrii/hermes-agent-docs)). Both
score "grounded" by the *model's own judgment*; neither has a deterministic
claim↔source check, so a false claim recalled ≥3 times clears every gate — the
GROUNDED≠TRUE failure on the memory surface. Muse's promotion scorer
(`selectPromotableMemories`) is the *same* frequency idea (`minHits≥3`,
recency-weighted), but the moat is the seam *before* it: `dropModelAssertedValues`
(`@muse/memory`) drops any extracted value whose distinctive tokens appear only
in the assistant reply and never in the user's turn, so a model-asserted or
repeated-injection "fact" never accumulates a single recall hit. Rivals can't add
this without suppressing the "agent learns from its own answers" behaviour they
advertise; Muse pays no such cost because the drop *is* the product.

**Shipped:** `scripts/eval-memory-poisoning.mjs` (`pnpm eval:memory-poisoning`) —
a deterministic adversarial battery proving the poisoned claim is dropped on every
injection while the *same* claim with forged hits would promote through the
frequency gate, and a user-stated claim survives both (no-collateral control).

### L1 — Local-by-construction is a deterministic moat, not a config flag (fire 1)

Hermes Agent ([nousresearch/hermes-agent](https://github.com/nousresearch/hermes-agent),
MIT) and OpenClaw ([docs.openclaw.ai](https://docs.openclaw.ai/concepts/memory),
MIT) both *support* Ollama, but cloud is their default and recommended path
(Hermes's own guide names Claude Sonnet 4.6 as the best model —
[remoteopenclaw.com](https://www.remoteopenclaw.com/blog/best-models-for-hermes-agent));
"local" is a mode a user opts into, never a guarantee their code enforces.
Neither could ship a release gate that *fails the build when cloud egress
becomes possible* — such a gate would block their own product. Muse can.

Just as the grounding moat is already a numeric ratchet
(`countGroundedSurfaces` / `countGroundedCases` → `detectRegressions` fails
`self-eval` the moment a fabrication-critical surface is dropped), the
local-by-construction moat — `classifyProviderLocality` + the fail-close
`LocalOnlyViolationError` thrown in `autoconfigure-model-provider.ts` — now
earns the same `egressGuards` scoreboard ratchet (`scripts/self-eval.mjs`),
turning "cloud egress refused in code" from a tested *property* into a
mechanically-defended *invariant*: drop a gated cloud provider id or delete an
enforcement throw and `pnpm self-eval` exits 1.

Hermes likewise relies on a self-prompted "Hallucination Gate" (the model asks
*itself* whether output is grounded —
[DEV deep-dive](https://dev.to/ahmad_rrrtx/the-agent-that-writes-its-own-manual-a-deep-dive-into-hermes-agents-self-improving-architecture-58h2)),
not the deterministic cite-or-drop code Muse gates fabrication=0 with; the same
structural asymmetry holds on both moats. Neither rival has a deterministic
grounding+citation floor at all.

**Shipped:** `countEgressGuards` ratchet (value 5 = 4 gated cloud ids + 1
fail-close throw site). **Open follow-up:** widen ratchet coverage to the voice
registry cloud-key-ignore and the localhost-only embeddings guard.
