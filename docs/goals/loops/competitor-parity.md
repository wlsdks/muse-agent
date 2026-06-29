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

## fire 4 · 2026-06-30 · skill v2.0 · fire4
meta: value-class=correctness-capability · pkg=@muse/model · kind=tool-call-hardening · verdict=PASS · firesSinceDrill=4
ratchet: pkg(model)/kind(tool-call-hardening) — DIVERSIFIED off the 2 recall fires (fire-2,3) as the journal demanded; model-pkg again (fire-1) but a NEW kind. fabrication 0.
- WHAT: harden `recoverToolArgsJson` — new `repairLooseJson` recovers the JSON malformations a small local model commonly emits (trailing commas, single-quoted objects, unquoted keys, curly/smart quotes), applied only after strict parse fails + RE-PARSED (invalid repair → discarded, never a wrong value).
- WHY (gap): reproduced — gemma4-class models emit these in tool-call args; each unrecovered = a DROPPED tool call = a failed agent action. Tool-calling reliability is the binding constraint on a local model (tool-calling.md). openclaw has a dedicated tool-call-repair package; Muse only handled fenced + brace-matched JSON.
- REVIEW: 8 behavioral tests (each malformation → the right OBJECT) + mutation RED + the SAFETY invariant (apostrophe-in-value preserved; re-parse guard ⇒ never a wrong value, only recover-or-undefined). model + wider suites green.
- RISK: the unquoted-key/single-quote regexes are heuristic — but the re-parse guard bounds the blast radius to "no recovery" (undefined), never a corrupted value. Streaming-level repair (openclaw stream-normalizer) is out of scope (deliberately — Muse uses native tool_calls, not text-streamed JSON).

## fire 5 · 2026-06-30 · skill v2.0 · fire5
meta: value-class=correctness-capability · pkg=@muse/model · kind=tool-call-hardening · verdict=PASS · firesSinceDrill=5
ratchet: pkg(model)/kind(tool-call-hardening) — SAME (pkg,kind) as fire-4 (sibling completion: fire-4=args, fire-5=names). model now 3× (fire-1,4,5); tool-call vein COMPLETE. **NEXT fire MUST diversify to a non-model, non-recall (pkg,kind)** (model+tool-call would hit the 8-fire ratchet soon). fabrication 0.
- WHAT: harden `sanitizeToolCallName` — strip a trailing call-paren `evaluate()`, surrounding quotes `"math_eval"`, an echoed OpenAI-style `functions.` prefix. Sibling of fire-4's arg repair → tool-call MALFORMATION recovery now complete (names + args).
- WHY (gap): each malformed NAME fails to match a registered tool → DROPPED call (same failure as a bad arg). Tool-calling reliability is the local-model binding constraint (tool-calling.md).
- REVIEW: 8 behavioral tests (each malformation → the exact registered name; clean name unchanged; empty→unknown) + mutation RED. No over-strip (a paren-less / mid-string-"functions" name is untouched — regexes are end-anchored). model suite 417 green.
- RISK: heuristic regexes — but bounded: worst case a real malformation isn't recovered (call drops as before), never a wrong name (over-strip guarded by end-anchors + the clean-name test).

## fire 6 · 2026-06-30 · skill v2.0 · NO-SHIP (honest exhaustion)
meta: value-class=assessment · pkg=none · kind=exhaustion · verdict=NO-SHIP · firesSinceDrill=6
ratchet: diversified the SCOUT off model/recall (probed tools, fs — fresh pkgs) per the journal flag; no buildable gap found.
- WHAT: scouted + adversarially probed ~8 areas across fresh packages — resilience, cost-estimation, a2a, web-content, context-compression (createModelDroppedContextSummarizer), tool-arg coercion (coerceScalar, cites arXiv:2509.18847), fs edit (applyEdit: line-block match + escaped-whitespace repair + hints), plugin-equiv (skills + mcp). ALL already-have / mature / correct.
- WHY no-ship: the competitor-parity CAPABILITY vein is exhausted — Muse already has openclaw/hermes' tractable capabilities (often citing the same papers), and the fresh functions I probed are well-hardened. Fabricating an already-have fire would violate the FRESHNESS GUARD. Honest exit per loop ⑥/EXHAUSTION.
- lesson: this theme's REAL value (fires 2,4,5) was CORRECTNESS BUGS in Muse's CORE (KO recall NFC, tool-call malformation), NOT missing capabilities — found by ADVERSARIALLY PROBING a real path, not by capability-scouting. A capability-parity theme on a mature codebase saturates in ~5 fires; the productive successor theme is "core-reliability bug-probing" (probe the real recall/tool/loop paths for correctness bugs), or re-theme entirely. Recommend re-pointing or pausing the loop.

## fire 7 · 2026-06-30 · skill v2.0 · fire7
meta: value-class=correctness-capability · pkg=@muse/agent-core+@muse/memory · kind=recall-bugfix · verdict=PASS · firesSinceDrill=7
ratchet: recall-bugfix 3rd time (fire-2,3,7) — NOT new vein hunting; this VALIDATES fire-6's lesson that bug-PROBING (not capability-scouting) is the productive successor. recall input-form robustness now: NFC (Hangul) + full-width fold (CJK width). 8-fire ratchet not tripped. fabrication 0.
- WHAT: full-width ASCII fold in the recall normalization — `normalizeForRecall` (after NFC) + `normalizeMemoryKey` (inline sibling) fold U+FF01–FF5E (full-width "１２３"/"ＡＢＣ") → half-width. Propagates to tokeniser, embedder, resolvesExact, normalizeField.
- WHY (bug, PROBED not scouted): `lexicalTokens('금액 １２３')` tokenised "１２３" separately from ASCII "123" → a note typed/pasted full-width (common on CJK keyboards) never matched an ASCII query. Same recall-miss CLASS as the NFC bug; the productive bug-probe pattern fire-6 predicted found it.
- REVIEW: behavioral test (full-width ≡ ASCII tokens) + mutation RED + TARGETED fold (NOT NFKC — ligature ﬁ left alone, Hangul/ASCII unchanged, no over-normalization). agent-core + memory suites green.
- lesson(meta): bug-PROBING the core keeps finding real recall-miss bugs after capability-scouting saturated (fire-6) — the loop has effectively self-pivoted to the productive theme. Recommend the human re-point the cron prompt to bug-probing explicitly.

## fire 8 · 2026-06-30 · skill v2.0 · fire8
meta: value-class=correctness-safety · pkg=@muse/agent-core · kind=fabrication-guard-bugfix · verdict=PASS · firesSinceDrill=8
ratchet: NEW kind (fabrication-guard-bugfix) — distinct from recall-bugfix (fire-2,3,7) and tool-call-hardening (fire-4,5); the anti-fabrication ARG guard, a different code path + user impact. 8-fire ratchet not tripped. **firesSinceDrill=8 → fire 10 is the non-deferrable JUDGE-DRILL** (firesSinceDrill≥10). fabrication 0 (verified NOT weakened).
- WHAT: `groundToolArguments` (drops a fabricated optional actuator arg the user never said) compared utterance↔arg tokens WITHOUT normalization. Now normalizes BOTH sites via the shared normalizeForRecall (NFC + full-width): `haystack` (utterance) + `contentTokens` (arg).
- WHY (bug, PROBED): a KO user typing an utterance NFD (macOS) + the model filling the arg NFC → the guard FALSE-DROPPED a REAL location ("회의실") as fabricated → the calendar event silently lost the location the user actually said. The anti-fabrication guard mis-firing AGAINST the user on KO locale. High value (it's the moat's guard, and it was eating real user data).
- REVIEW: 3 behavioral tests (NFD-utterance keeps location; full-width grounds; **genuinely-fabricated arg STILL dropped** = guard not weakened) + mutation RED on BOTH normalization sites (each independently load-bearing, opposite directions) + suite 27 green. fabrication=0 preserved (the drop-the-ungrounded path is intact; normalization only removes FALSE drops).
- RISK: normalization can only make MORE tokens match — bounded by the conservative "any-overlap grounds" design; verified it doesn't open a fabrication hole (a truly absent arg still drops).
