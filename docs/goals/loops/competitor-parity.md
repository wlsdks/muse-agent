# Loop journal — competitor-parity (openclaw + hermes → Muse gap-filling)

Theme: study /Users/jinan/ai/openclaw (TS, MIT) + /Users/jinan/ai/hermes-agent (Python, MIT/Apache),
find what Muse LACKS, reimplement the pattern (attributed, no verbatim copy), in BIG chunks per fire.
Tier1 (local commit, no push). Worktree: /tmp/muse-competitor-parity. Slug: competitor-parity.

## Candidate gaps (seed — each fire VERIFIES the gap is real before building; Muse may already have it)
- ◦ Plugin SDK / third-party extension package contract (openclaw plugin-sdk, plugin-package-contract) — Muse has `skills` but not a versioned plugin package system. VERIFY vs packages/skills first.
- ◦ Web-content extraction (openclaw web-content-core) — page → clean readable markdown. Muse has `browser`; check if clean-extraction exists.
- ✓ Context compression — ALREADY-HAVE (dropped-context-summarizer.ts, context-transforms.ts)
- ✓ Model catalog — DONE (fire 1)
- ✓ A2A — ALREADY-HAVE substantial (a2a-message, agent-card, signing, peer-registry, receive-quarantine)

## Fires

## fire 1 · 2026-06-30 · skill v2.0 · fire1
meta: value-class=new-capability · pkg=@muse/model+@muse/cli · kind=catalog+CLI · verdict=PASS · firesSinceDrill=1
ratchet: pkg(model,cli)/kind(new-capability) — fire-0 was docs/chore, this is model+cli (diverse). fabrication 0.
- WHAT: model CAPABILITY catalog — `MODEL_CATALOG` + query fns (byCapability/findCatalogModel/localCatalogModels/byProvider) in @muse/model, + `muse models [--vision|--tools|--local|--provider|--json]` CLI. Big-chunk (catalog + query + CLI + tests).
- WHY (gap): openclaw has model-catalog-core; Muse had per-adapter ModelInfo but NO unified queryable capability index nor a `muse models` command (freshness-guarded: 0 ModelCatalog/byCapability/muse-models hits). Complements `muse setup cloud` — pick a model by capability, offline.
- REVIEW: behavioral tests (query/filter logic, not config assertions) + mutation RED + live CLI (--local --vision → gemma4 only). Reimplemented in Muse's ModelInfo shape, openclaw (MIT) attributed, no verbatim copy.
- RISK: catalog DATA is curated/static (capability values conservative; may lag new models) — the QUERY logic is what's tested. `local` honestly = ollama-only (no cloud mislabeled local).

## fire 2 · 2026-06-30 · skill v2.0 · fire2
meta: value-class=correctness-capability · pkg=@muse/agent-core+@muse/autoconfigure · kind=recall-bugfix · verdict=PASS · firesSinceDrill=2
ratchet: pkg(agent-core,autoconfigure)/kind(recall-bugfix) — fire-0 docs, fire-1 model+cli, fire-2 agent-core/recall (diverse). fabrication 0.
- WHAT: NFC normalization in the recall path — `normalizeForRecall` + `lexicalTokenList` NFC-normalizes; sibling-audited the embed input (embedder-base) to NFC too (one seam, lexical + semantic agree).
- WHY (gap): openclaw has normalization-core; Muse's recall tokeniser did NOT NFC-normalize → a macOS-NFD Korean note never matched an NFC query (REPRODUCED: NFD vs NFC '한국어' → disjoint token sets). The grounding edge silently missed a real KO note + falsely abstained — a CORE-edge correctness bug, high value for a bilingual + macOS product.
- REVIEW: behavioral test (NFD phrase ≡ NFC phrase tokens) + mutation RED + ASCII unchanged + NFC (not NFKC, lossless). test:changed agent-core 1524 + autoconfigure 282 green.
- RISK: NFC is canonical-composition (safe); other raw-string recall comparisons (citation exact-resolve, memory-key match) may still be NFC/NFD-naive — noted as a follow-up sibling (not in this fire's proven scope).

## fire 3 · 2026-06-30 · skill v2.0 · fire3
meta: value-class=correctness-capability · pkg=@muse/memory+@muse/agent-core+@muse/recall · kind=recall-bugfix · verdict=PASS · firesSinceDrill=3
ratchet: pkg(memory,agent-core,recall)/kind(recall-bugfix) — 2nd recall fire (fire-2 sibling completion, NOT new vein); 8-fire ratchet not tripped (4 fires). NEXT fire MUST diversify to a different (pkg,kind). fabrication 0.
- WHAT: NFC sibling-audit completion — fire-2 fixed the lexical tokeniser; this NFC-normalizes the 3 remaining recall-comparison sites: `normalizeMemoryKey` (memory, inlined — below agent-core, cycle), `resolvesExact` (agent-core citation resolution), `normalizeField` (recall conflict). KO recall fix now COMPLETE (lexical + semantic + key + citation + conflict all NFC).
- WHY (gap): a half-done NFC fix is a real risk — some recall paths normalized, others not = inconsistent KO matching. openclaw normalization-core centralizes this; Muse's was scattered + NFC-naive at these 3 sites.
- REVIEW: normalizeMemoryKey NFD≡NFC test + mutation RED + ASCII slug unchanged. resolvesExact/normalizeField call the fire-2-tested normalizeForRecall (primitive covered) + caller regression (memory 393, recall 40 green). memory gained NO agent-core import (acyclic).
- RISK: resolvesExact/normalizeField lack a DIRECT behavioral test (private fns) — covered by the tested primitive + caller suites; a dedicated citation/conflict KO test would be a stronger lock (follow-up).
