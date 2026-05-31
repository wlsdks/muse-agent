# Outward Target Map — the loop's self-directed north star

The loop sets and evolves its own direction. A human intervenes
only by direct command. Until then the loop decides what "outward"
means, using its own judgement of what a great personal AI
assistant does.

## North star

Muse is a personal AI assistant in the spirit of JARVIS: it
**proactively speaks first** from real context (schedule, events,
patterns, follow-ups) AND **responds instantly and completely the
moment it is addressed**, running the full agent loop to finish the
task. Two qualities define every outward goal:

- **Proactive** — initiates from real context before being asked.
- **Instantly responsive & complete** — when addressed, answers now
  and carries the task to done end-to-end.

## Current session focus — 2026-05-27 (human-directed)

P0–P21 are delivered (archived in `archive/TARGETS-P0-P21.md`;
their capability ledger in `archive/CAPABILITIES-through-2026-05-27.md`).
Muse's daemons exist but live only inside the `apps/api` server,
env-gated — they do NOT run as a real background process on the
user's Mac. **This session pursues two sanctioned directions, the
loop choosing the highest-value one per iteration: (A) make the
proactive / perception daemons actually RUN on this Mac as one
user-launched process and prove end-to-end a notice really fires
(target P22); (B) apply good capabilities from freely-usable open
research under the guardrails below.**

Every slice is proven by a real, surface-level check (CLI smoke /
integration / `smoke:live`) driving the real code path against a
contract-faithful fake — never a stubbed registry, never a
happy-path-only assertion (`outbound-safety.md`). Proactive notices
go to the user's OWN channel (low-risk path); web-watch is
read-only — no autonomous third-party send.

## Applying open research (human-directed 2026-05-28)

The loop MAY adopt a capability from a paper when ALL hold; when in
doubt, SKIP:

- **Freely usable.** The paper is openly readable AND nothing
  restricts implementing its idea — open method, no patent / licence
  bar on use. A restricted or patent-encumbered technique is out.
- **Local-first.** No new paid dependency, no cloud API key; runs on
  the local Qwen / Ollama; deterministic where it can be.
- **Cited in the CODE.** A one-line WHY comment names the paper + id
  at the implementation site (e.g.
  `// importance-modulated decay (FadeMem, arXiv 2601.18642)`) — an
  allowed WHY comment per `code-style.md` — AND the `CAPABILITIES.md`
  line names it too.
- **Verified, effect measured.** Ships as a normal slice with a
  green surface-level check; where feasible the check MEASURES the
  paper's claimed effect, not just that the code runs. A research
  idea with no runnable check is not delivered.

Sizing (both directions): a slice too large for one ~10-min commit
is DECOMPOSED across iterations — one end-to-end vertical increment
each, per `iteration-loop.md`. Never crammed into one oversized
turn; never half-shipped.

## Active target

**P36 — Background self-learning, brake-and-proof-first (loop-v2 PART A2 /
B1).** The headline's "grows-with-you" core: Muse learns from corrections
while idle, on its own, without straining the laptop. Built brake-FIRST — the
resource gates land before any unattended LLM writer. Verified by the rung-4
proof shape (unit / 2-session / eval:self-improving), NOT cited-answer+refusal.

- [x] **P36-1 Real OS-idle brake (B1 Slice 0 prerequisite).** The consolidate
  daemon gated only on Muse-/api activity (`lastActivityMs`), which reports
  idle exactly when the laptop is busy in another app. New `os-idle.ts` reads
  the real system-wide HID idle (`ioreg` `HIDIdleTime`), fail-closed; the LLM
  merge now ALSO requires the MACHINE idle ≥ threshold (opt-in seam, wired in
  the daemon) so it never strains the laptop while the user works elsewhere.
  Proven by unit tests (parse / fail-closed / brake predicate / tick gate:
  OS-busy or unknown → no merge; both idle → merge) + a LIVE probe on this
  macOS box (osIdleMs ≈ 10632s from real ioreg); api 756 tests + `pnpm lint`
  0/0. Brake-first INFRA — felt payoff lands with the writer slice (Slice 1).
  (this commit)

**P35 — Felt experience: make Muse FEEL like the SF confidant (loop-v2 PART
B2).** The front door (P34) is delivered + proven; the headline's other half
is the *felt* quality — recall that reads like a memory, honest refusals that
offer a hand, growth you can sense — built ONLY under the B2 guardrails
(honesty never traded for feel; felt framing is deterministic code, never a
second model call). Verified live on local Qwen via the same cited-answer +
honest-refusal mock-corpus check where applicable.

- [x] **P35-1 Citation-as-voice (B2 S1, build-first).** `muse ask` renders
  each cited note as a memory — "📎 From your notes … • from your note of
  <date> — '<verbatim snippet>'" + the openable path — instead of a bare
  filename, by pure deterministic code (`formatSourceReceipts`: date from the
  filename + a verbatim chunk excerpt, no second model call, gate untouched,
  post-gate so a refusal renders no receipt). Proven LIVE on qwen3:8b: the
  WireGuard answer shows the dated memory receipt + path; the sister's-birthday
  refusal shows none; `commands-ask-receipts.test.ts` + `pnpm lint` 0/0.
  (c7297ad3)

- [x] **P35-2 Citation-as-voice quotes content, never a heading.** P35-1's
  receipt excerpted the chunk's opening, which on a `# Heading`-led note read
  robotically. `relevantSnippet` now drops markdown headings and picks the
  highest query-overlap content line (reusing the recall lexical primitives),
  so the receipt quotes a sentence the user actually wrote. Proven LIVE on
  qwen3:8b: the WireGuard answer's receipt quotes a content sentence (not "#
  WireGuard VPN setup"); the refusal shows none; `commands-ask-receipts.test.ts`
  + `pnpm lint` 0/0. (8d23b182)

- [x] **P35-3 Narrate the wait (B2 S3).** On a 10–40s local model the
  pre-answer gap reads as a hang. `muse ask` now emits two REAL stage deltas —
  "🔎 searching your notes…" and "💭 generating your answer on the local
  model…" — bracketing the existing grounded banner, suppressed under --json,
  inventing no step (latency-honest). Answer/gate/receipt/refusal untouched.
  Proven LIVE on qwen3:8b: both deltas appear before the cited "MTU 1380"
  answer and before the honest sister's-birthday refusal; cli suite green (no
  regression) + `pnpm lint` 0/0. (5d9eef98)

- [x] **P35-4 Warm honesty (B2 S2).** An honest refusal now closes with one
  on-brand deterministic line "(I'd rather tell you that than guess — add a
  note on this and I'll have it next time.)" when the user HAS notes (empty
  corpus → on-ramp hint instead; cited answer → nothing). No note pointer, so
  no P34-11 regression; `shouldWarmClose` (refusal AND notes>0) is pure +
  tested. Proven LIVE on qwen3:8b: the sister's-birthday + car must-refuses get
  the warm close, the MTU answer does not; `commands-ask-refusal.test.ts` +
  `pnpm lint` 0/0. (this commit)

**P34 — The front door (loop-v2 headline: the moat is invisible without
the door).** Per loop-v2 B0 §3, a privacy-bound first-time user must be able
to SEE Muse's edge — a cited answer AND an honest refusal — in seconds, with
zero dev toolchain and no notes ingested yet, BEFORE they invest in getting
their real corpus in. The first rung is a bundled-corpus demo; later rungs are
one-command install (detect/pull Ollama + model), one real ingest format, and
continuous folder-watch ingest. Direction: loop-v2 locked headline (front door
FIRST, then felt self-learning).

- [x] **P34-1 `muse demo` — the zero-setup cited-answer + honest-refusal
  demo.** `muse demo` runs the REAL `muse ask` recall path against a bundled
  sample corpus (shipped in the cli package) inside a throwaway HOME — a
  HOME/USERPROFILE override + the new `MUSE_NOTES_INDEX_FILE` resolver isolate
  every `~/.muse/*` default so the user's real data is never touched — and
  shows ONE answerable question (cited "MTU 1380" + openable 📎 Sources) and
  ONE must-refuse question (honest "I'm not sure", no fabrication). `--top 12`
  injects the whole tiny corpus so the answerable note is never ranked out.
  Proven LIVE on qwen3:8b via the built CLI + `commands-demo.test.ts` +
  autoconfigure tests; `pnpm lint` 0/0. (c325f420)

- [x] **P34-2 Corpus ingest shows progress + tolerates a bad file VISIBLY.**
  The engine already walked `.pdf`/`.txt` and had partial-failure tolerance,
  but the headline `muse ask` path SWALLOWED it: a first ingest was a silent
  hang and a corrupt file was skipped with zero feedback. Now `muse ask`'s
  auto-reindex streams per-file progress (`+ <file> (n chunks embedded)`) and
  the extract-failure path emits `✗ <file> (could not read — skipped:
  <reason>)`, so a beachhead user sees life during a slow first ingest and a
  corrupt/unreadable file is visibly skipped, not fatal. Proven LIVE on
  qwen3:8b against a `.muse-dev` mock corpus (seed notes + a corrupt `.pdf`):
  streamed progress + the ✗ skip line, then a cited "MTU 1380" answer + 📎
  Sources AND an honest refusal; `commands-notes-rag.test.ts` + `pnpm lint`
  0/0. (6652986c)

- [x] **P34-3 Kill the false refusal — hybrid recall on the headline path.**
  At default top-3 `muse ask` false-refused an answerable question because the
  chat-only path ranked notes by PURE embedding cosine, so a query with strong
  keywords ("WireGuard", "MTU") ranked the answer note ~5th and it fell out of
  the top-K (the GUARD-THE-EDGE failure: a false refusal makes "honest" into
  "useless"). The headline path now fuses cosine + lexical keyword ranks via
  RRF (the same hybrid the `knowledge_search` path already used, P23), reusing
  agent-core's lexical primitives, no re-embedding, absolute cosine preserved
  for the confidence framing. Proven LIVE on qwen3:8b at DEFAULT top-3 against
  a `.muse-dev` mock corpus: the WireGuard + rent questions now return cited
  answers (vpn note ranked FIRST) while the sister's-birthday question still
  honestly refuses; `commands-ask-mmr.test.ts` + `pnpm lint` 0/0. (faa905b4)

- [x] **P34-4 No false LOW-confidence caution on a correct cited answer.**
  The CRAG framing flagged a correctly-grounded answer "⚠ LOW confidence —
  verify, may not be in your notes" whenever the top match's absolute cosine
  sat below threshold (nomic compresses cosine), undercutting trust in an
  answer that IS grounded — a soft false-refusal. The framing now considers
  lexical strength: a strong keyword match (≥2 distinct query content tokens
  in a grounded chunk) upgrades an ambiguous-cosine verdict to confident,
  while a must-refuse question (no shared tokens) stays LOW and the citation
  gate remains the hard backstop (fabrication=0 preserved). Proven LIVE on
  qwen3:8b at default top-3: the WireGuard answer now shows a clean grounding
  line + cited "MTU 1380", while the sister's-birthday question still shows
  LOW confidence and refuses; `commands-ask-crag.test.ts` + `pnpm lint` 0/0.
  (a2dedb48)

- [x] **P34-5 Bulk folder ingest — get a real corpus in, in one command.**
  `muse read <dir> --save-to-notes <prefix>` now ingests every supported
  document (pdf/txt/md/markdown/log/csv) under a directory (recursively) into
  the notes corpus as `.md` notes under the prefix, so a beachhead user with a
  pile of downloads/exports gets them all searchable in ONE command instead of
  one `muse read` per file. Per-file progress + partial-failure tolerance (a
  corrupt file is skipped VISIBLY, not fatal). Bug found+fixed live: notes were
  first saved without a `.md` extension so the index walker skipped them and
  `muse ask` couldn't cite them — the save now appends `.md`. Proven LIVE on
  qwen3:8b against a `.muse-dev` docs folder (a .txt, a nested .md, a corrupt
  .pdf, isolated HOME): "ingested 2, skipped 1", then `muse ask` cited both
  ingested facts (warranty.md, manuals/trip.md) + 📎 Sources and honestly
  refused an uncovered question; `commands-read.test.ts` + `pnpm lint` 0/0.
  (8f142b61)

- [x] **P34-6 Single-file `--save-to-notes` is actually searchable.** The
  single-file `muse read <file> --save-to-notes <id>` path told the user "now
  searchable" but saved a bare extensionless note the notes-index walker
  skipped, so `muse ask` answered "I don't have access" on a just-ingested
  fact (the single-file sibling of P34-5's bug). A shared
  `ensureNoteMarkdownExtension` now guarantees an indexable `.md`/`.markdown`/
  `.txt` extension on both the single-file and bulk paths. Proven LIVE on
  qwen3:8b (isolated HOME): `muse read garage.txt --save-to-notes garage` →
  `garage.md`, and `muse ask` cited "7731 [from garage.md]" (was "I don't have
  access"), while an uncovered question still honestly refused;
  `commands-read.test.ts` + `pnpm lint` 0/0. (c8441e84)

- [x] **P34-7 Continuous folder-watch corpus ingest — the corpus stays live.**
  `muse watch-folder --ingest` now folds each newly-dropped document INTO the
  notes corpus as a citable `.md` note (searchable via `muse ask`) instead of
  firing a proactive notice — the day-2 "stays live without re-running ingest"
  habit, with no manual step. Reuses the `muse read` extract/save contract, so
  a corrupt drop is skipped (✗) without crashing the watcher; the original is
  archived. Proven LIVE on qwen3:8b (isolated HOME): dropped `pool.txt` + a
  corrupt `.pdf` into a watched inbox → ingested `pool.txt → inbox/pool.md`,
  skipped the corrupt one, then `muse ask` cited "4417 [from inbox/pool.md]"
  and honestly refused an uncovered question; `commands-watch-folder.test.ts`
  + `pnpm lint` 0/0. (500e4112)

- [x] **P34-8 Empty-corpus first-run on-ramp.** A brand-new user who runs
  `muse ask` with no notes yet got an honest refusal but no guidance — a
  dead-end. `muse ask` now prints a one-time on-ramp hint (naming `muse demo`,
  `muse read --save-to-notes`, `muse watch-folder --ingest`) ONLY when the
  corpus is empty, and still answers honestly (the refusal is unchanged; the
  hint never fires once any note exists). Proven LIVE on qwen3:8b (isolated
  HOME): empty corpus → hint + honest refusal; populated corpus → no hint, a
  cited "MTU 1380" answer + Sources, and an honest refusal on a must-refuse;
  `commands-ask-onboarding.test.ts` + `pnpm lint` 0/0. (1c5ad06d)

- [x] **P34-9 The on-ramp hint never lies to a user whose embedding is down.**
  P34-8's hint was gated on indexed chunks, so when Ollama was unreachable
  (0 chunks embedded) a user WITH notes was wrongly told "your corpus is
  empty". It now counts note FILES on disk (`notesCorpusFileCount`),
  independent of embedding — so the hint fires only for a truly empty corpus,
  and a populated-but-unindexed corpus gets the "notes search unavailable —
  ollama pull" guidance instead. Proven LIVE on qwen3:8b: Ollama-down + a
  6-note corpus → no false "empty" line; Ollama-up + empty dir → hint fires;
  Ollama-up + populated → cited "MTU 1380" + Sources and an honest refusal;
  `commands-ask-onboarding.test.ts` + `pnpm lint` 0/0. (6df3d076)

- [x] **P34-10 Richer demo payoff + full-oracle edge sweep.** `muse demo` now
  shows TWO answerable questions citing DIFFERENT notes (MTU + rent) before the
  must-refuse, so the zero-setup payoff proves cited recall is real across the
  corpus, not one lucky hit. This fire also ran a full live regression sweep of
  the EXPECTED.md oracle at default top-3: all 6 answerable cited correctly, all
  4 must-refuse honestly refused — the recall edge is green end-to-end. Proven
  LIVE on qwen3:8b; `commands-demo.test.ts` + `pnpm lint` 0/0.
  NOTE: the front-door rungs verifiable under the cited-answer+refusal mandate
  are now exhausted (demo, single/bulk/watch ingest, hybrid recall, confidence
  calibration, empty-corpus on-ramp, model-readiness error UX — all done +
  proven). The only undone front-door rung is (b) a real one-command installer,
  whose proof is a clean-room container/CI test, not live recall. Next fire
  should either scope (b) to a container proof or advance to rung 4 (felt
  self-learning, 2-session proof). (e5404f5e)

- [x] **P34-11 A refusal cites nothing (cross-lingual fabrication=0 fix).** A
  Korean must-refuse (which the English oracle sweep missed) honestly refused
  but the local model appended a spurious `cite as: [from preferences.md]`,
  which the gate kept (real source) and the Sources footer surfaced as "open
  to verify" — a citation on an answer that asserts nothing. A precision-first
  `answerIsRefusal` (EN+KO) now drops all citations from a refusal: the Sources
  footer is suppressed on every path and the inline `[from …]` is stripped on
  the buffered `--with-tools`/`--json` paths (chat-only streams live, so the
  inline marker can still flash — the known streaming limitation; the
  followable footer is gone everywhere). Proven LIVE on qwen3:8b: the Korean
  sister's-birthday refusal → no Sources footer; the Korean WireGuard
  answerable → still cited + footer (no regression); `commands-ask-refusal.test.ts`
  + `pnpm lint` 0/0. (this commit)

**P33 — Reinforcement learning over Muse's memory (the model is fixed,
so RL lives in the MEMORY, not the weights).** Close the self-improvement
loop: today Muse only LEARNS new strategies (ReasoningBank distillation,
skill authoring); it doesn't yet learn which learned things actually WORK.
Give each learned strategy a real outcome reward — reinforce the ones used
cleanly, decay the ones that keep getting corrected/undone/vetoed — and let
reward shape what gets injected, so the playbook self-reinforces toward what
helps this user (ACE arXiv:2510.04618 + the sibling veto store; reward-shaped).
Direction set 2026-05-31 by 진안 ("강화학습이 중요해").

- [x] **P33-1 Reward-weighted playbook (reinforce/decay + selection).** A
  clamped `reward` on each strategy that reward-weighted `rankPlaybookStrategies`
  blends into selection (proven first; a repeatedly-corrected one decays out of
  the injected top-K); `adjustPlaybookReward` persists the update; the signal is
  AUTOMATIC — at session end the strategy a correction implicates is docked,
  alongside ReasoningBank distillation. Flows through BOTH injection paths
  (`buildPlaybookProvider` runtime + `selectPlaybookSection` chat-only `muse ask`).
  `muse playbook` shows each strategy's reward; `muse playbook distill` reports
  what it decayed. Verified: agent-core reward-rank + clamp tests, mcp
  adjust/clamp/back-compat tests, the distill decay test, `pnpm check` green, and
  LIVE through the built CLI (`playbook list` renders ⟨reward⟩; a −4 strategy is
  deranked below an equally-relevant peer).
- [x] **P33-2 Bidirectional reward — reinforce on explicit approval.** The
  positive half of the loop: `detectApprovals` (agent-core, precision-first
  EN+KO mirror of `detectCorrections` — fires on "perfect"/"exactly right"/
  "완벽해"/"딱 좋아", never bare "ok"/"thanks"/"좋아"/"고마워") feeds a session-end
  REINFORCE that credit-assigns each approval to the most-similar existing
  strategy and lifts its reward (+1), the mirror of correction-decay and once
  per strategy per session. So the bank learns from "you got it right" too, not
  just absence-of-negative. `muse playbook distill` reports both ↑ reinforced and
  ↓ decayed. Verified: detectApprovals detector tests (13 endorsements fire, 9
  bare-acknowledgements don't) + the cli reinforce test (an approval lifts the
  applied strategy to +1, unrelated untouched); agent-core 1068 / cli 1548 green,
  lint 0/0.
- [x] **P33-3 Learned avoidance — retire a repeatedly-corrected strategy from
  injection.** The extinction endpoint: a strategy decayed to the floor
  (reward ≤ `PLAYBOOK_AVOID_BELOW` = −4) is EXCLUDED from injection entirely by
  `rankPlaybookStrategies`, even in a small bank (≤ topK) where ranking would
  otherwise return everything — so a consistently-corrected strategy stops being
  applied, not just sinks. Soft + reversible (the veto-store parallel): it stays
  in the bank, marked "· avoided (not injected)" in `muse playbook`, and an
  approval can lift it back. Verified: rank-exclusion tests (dropped even at bank
  ≤ topK; −3 still injects; all-avoided → empty) + `isAvoidedStrategy` boundary,
  and LIVE through the built CLI (the avoided marker + the −4 strategy excluded
  from a 2-strategy bank). agent-core 1072 / cli 1548 green, lint 0/0.
- [x] **P33-4 Extend the reward loop to authored skills.** RL now spans a
  SECOND memory type: a skill the user keeps correcting stops being applied,
  one they approve earns standing. A sidecar `skill-rewards.json` (name→reward,
  kept out of each SKILL.md so a decay never rewrites the body) + `adjustSkillReward`
  (clamped, mutation-queued); at session end `applySkillRewardsFromSession`
  credit-assigns each correction/approval to the authored skill the live prompt
  WOULD apply — via the SAME `selectRelevantSkills` — and decays/reinforces it;
  `buildSkillsPrompt` drops an avoided skill (reward ≤ −4) from the per-turn
  prompt entirely; `muse skills authored` shows reward + "· avoided". Verified:
  store + selection-avoidance + decay/reinforce tests, and LIVE through the
  built CLI (the avoided marker + a −4 skill excluded from a matching prompt).
  mcp 1112 / cli 1553 green, lint 0/0.
- [x] **P33-5 Manual reward control — the user steers the RL.**
  `muse playbook reward <id> [amount] [--down]` and `muse skills reward
  <name> [amount] [--down]` let the user reinforce or penalise a learned
  strategy/skill by hand (clamped via the SAME adjust functions the auto-signal
  uses). So a wrongly-penalised one can be RESCUED back above the avoid line and
  a known-good one PRE-TRUSTED — the reversibility + control that makes the
  (default-off) auto-RL safe to enable. Verified by command tests (reinforce /
  --down penalise / clamp / prefix-id / unknown refused-and-not-written) and
  LIVE through the built CLI (reward +3, then --down 8 clamps to −5 and the
  strategy shows "· avoided"). cli 1556 green, lint 0/0.
- [x] **P33-6 Make the learning visible & trustworthy — `muse learned`.**
  One honest view composing the playbook + authored-skill + skill-reward +
  reflection stores (no model call): the strategies/skills Muse now TRUSTS
  (reward ≥ +1), the ones it learned to AVOID (reward ≤ −4, no longer applied),
  and its grounded reflections — so the default-off RL learning is legible
  enough to trust and turn on (the empty state explains how to enable it).
  This is the "shows its work" edge turned on Muse's OWN self-improvement.
  Verified by `renderLearnedDigest` tests + LIVE through the built CLI (trusted
  +3/+2, avoided −5, dated reflection). cli 1560 green, lint 0/0.
- [x] **P33-7 Reward-weighted skill ordering — skill-RL reaches playbook
  parity.** Among equally-relevant authored skills competing for the limited
  per-turn body slots, the reinforced (higher-reward) one is now selected
  first, not just the avoided ones excluded — `selectRelevantSkills` blends
  `SKILL_REWARD_RANK_WEIGHT × reward` into the rank AFTER the relevance gate
  (reward orders relevant skills, never makes an irrelevant one relevant).
  So skill-RL mirrors the playbook end-to-end: decay · reinforce · avoid ·
  RANK. Verified by chat-skills tests (higher-reward wins the slot over the
  name tie-break; a +5 zero-overlap skill still excluded). cli 1562 green,
  lint 0/0. (Remaining P33 idea: injection-tracking for precise credit
  instead of the selection heuristic.)

**P32 — Grounded "dreaming" (idle memory consolidation that can't make
things up).** Adopt the offline reflection competitors lean on (OpenClaw's
"dreaming"; Generative Agents reflection, arXiv:2304.03442) in Muse's honest,
local key: while idle, synthesise recent episodes/notes into a few higher-level
insights about the user — and keep ONLY insights GROUNDED in real sources (each
cites the episode/note ids it came from; an invented source is stripped, an
under-supported insight dropped). Muse dreams about your life; every insight
points back to where it came from — the identity ("can't make things up") made
true for self-knowledge, which no cloud "dreaming" can match.

- [x] **P32-1 Grounded reflection synthesis (core + honesty guard).**
  `synthesizeReflections` (agent-core) turns recent `{id,text}` items into
  reflections via the LOCAL model; `parseReflections` deterministically strips
  any cited source id that isn't a real input and drops a reflection below
  `minSupport` distinct sources — the model cannot ground an insight in a source
  the user doesn't have. 11 unit tests (strips invented ids, minSupport, dedupe,
  junk-tolerant JSON) + a LIVE qwen3:8b battery (`verify-reflection-synthesis`,
  in `eval:self-improving`): a recurring networking theme across 3 episodes is
  synthesised and grounded in the right real ids, and the grounding invariant
  holds for every reflection.
- [x] **P32-2 Persist + surface grounded reflections.** `reflections-store`
  (atomic, dedup on the normalised insight) + `muse reflections [refresh]`:
  `refresh` runs `synthesizeReflections` over recent episodes and stores the
  grounded ones; `muse reflections` lists each insight WITH the real episode ids
  it came from. Verified live: 5 seeded episodes → 2 grounded reflections (the 3
  networking episodes grouped + cited as ep-101/102/103; the 2 admin ones as
  ep-104/105). 4 store + 3 cli tests.
- [x] **P32-3 Auto-dream during daemon idle.** `muse daemon` runs a throttled
  background `reflectionTick` (off by default, `MUSE_REFLECTION_ENABLED`; slow
  cadence, `MUSE_REFLECTION_INTERVAL_MS` default 6h) that synthesises grounded
  reflections from recent episodes with NO user action and persists only the
  ones cited to real episodes — so insights accrue while Muse sits resident.
  Also fixed: the tick now writes via `resolveReflectionsFile(e)` (the daemon's
  injected env), not a global `process.env` path. Verified by a contract-faithful
  daemon test — enabled + 3 episodes → exactly one grounded reflection persisted
  citing only e1/e2/e3 and a `reflections: +1` line; flag unset → nothing written
  (the gate is real). Closes the P32 dreaming epic (synth → surface → idle auto-run).

## Delivered — P31 (Muse acts on the world, gated draft-first)

Closed the perceive→propose→confirm→act loop: an autonomous trigger PROPOSES a
state-changing action; nothing leaves until the user confirms it. The JARVIS
frontier — "acting" — done strictly per `outbound-safety.md`.

- [x] **P31-1 Proposed-action confirm-to-execute (engine + `muse
  propose`).** A `proposed-action` store + `proposeMessageAction`
  (persists `pending`, sends NOTHING) + `confirmProposedAction`
  (executes once, replay-guarded on status, logs `performed`) +
  `declineProposedAction` (`declined` + logs `refused`), surfaced as
  `muse propose list | approve <id> | decline <id>`. A send failure
  leaves it `pending` (retryable, logged `failed`). Proven by
  contract-faithful smokes: `packages/mcp/test/proposed-action.test.ts`
  (propose→pending+no send; approve→1 send+executed+performed log;
  re-approve→no double-send; decline→no send+refused; failure→pending)
  and `apps/cli/src/commands-propose.test.ts` (list/approve/decline
  surface). No autonomous send anywhere.
- [x] **P31-2 Producer: the daemon proposes.** A draft-first objective
  actuator (`createProposingObjectiveActuator`) makes a met standing
  objective PROPOSE its message instead of sending it; the daemon uses
  it when `MUSE_OBJECTIVES_PROPOSE` is set (default off → unchanged
  auto-send). Proven: `muse daemon --once` with propose-mode + a met
  objective creates a pending proposed action and sends NOTHING —
  `apps/cli/src/commands-daemon.test.ts`. **The full
  perceive→propose→confirm→act loop, with no autonomous send.**
- [x] **P31-3 Proposals expire (timeout → no send).** Each proposal
  carries an `expiresAt` (default 24h); past it it's inert —
  `isProposalActionable` is false, `muse propose list` omits it, and
  `confirm` refuses `"expired"` without sending. Closes
  outbound-safety's "approval times out → the action does not happen"
  for the propose flow — `packages/mcp/test/proposed-action.test.ts`.

## Delivered — P30 (make the daemon debuggable)

`muse daemon --status` reports resolved source paths + launchd
autostart state. Audited PASS (README ledger, `P30 audit`).

- [x] **P30-1 `muse daemon --status` shows the resolved source paths.**
  Beyond the per-tick enabled/disabled lines, `--status` now prints the
  resolved config/tasks/reminders/followups/objectives file paths — the
  first thing to check when a tick reads a different file than the user
  thinks. Proven: `--status` output contains the resolved task /
  reminder / objective paths — see `apps/cli/src/commands-daemon.test.ts`.
- [x] **P30-2 `--status` reports launchd autostart state.** It now also
  reports whether the LaunchAgent plist (P22-6) is installed — i.e.
  whether the daemon will come back after a reboot — with the path or a
  `run muse daemon --install` hint. Proven: no plist → "not installed",
  plist present → "installed" — see `apps/cli/src/commands-daemon.test.ts`.

## Delivered — P29 (watch the resident daemon work)

`muse daemon --print` echoes every delivered notice to stdout for
foreground observability. Audited PASS (README ledger, `P29 audit`).

- [x] **P29-1 `muse daemon --print` echoes deliveries to stdout.** A
  send-also-prints Proxy over the messaging registry echoes every
  delivered notice (from ANY tick) to stdout while still delivering to
  the channel, so the foreground daemon is observable inline. Proven:
  with `--print` the delivered notice text appears in stdout, without
  it only the tick summary, channel delivery unaffected — see
  `apps/cli/src/commands-daemon.test.ts`.

## Delivered — P28 (position retrieved context for the local model)

knowledge_search edge-loads the top-K (Lost in the Middle) so the most
relevant passages sit at the context edges. Audited PASS (README
ledger, `P28 audit`).

- [x] **P28-1 Edge-load knowledge_search results (Lost in the Middle).**
  Both `knowledge_search` surfaces reorder the top-K via
  `edgeLoadByRelevance` so the most relevant passages sit at the
  context edges (first + last) and the weakest in the middle, because
  models attend best to the start/end of context (Liu et al. 2023,
  "Lost in the Middle", arXiv 2307.03172). The top match stays first so
  citation is unaffected. Proven: best-first `[a,b,c,d,e]` →
  `[a,c,e,d,b]` — `packages/agent-core/test/knowledge-recall-agent.test.ts`.
  Deterministic, no dep, local.

## Delivered — P27 (the daily briefing runs in the resident daemon)

`muse daemon` (opt-in) delivers the situational brief: objective
status + imminent tasks & calendar + birthdays + a related note.
Audited PASS (README ledger, `P27 audit`).

- [x] **P27-1 Briefing tick in the launcher.** `muse daemon` runs the
  situational briefing (opt-in `MUSE_BRIEFING_ENABLED`), composing
  `runDueSituationalBriefing` over objectives + tasks-derived imminent
  (`deriveBriefingImminent`) + the shared knowledge enricher, self-
  deduped by its sidecar (default 4h window). Proven by a
  contract-faithful CLI smoke (an imminent task ⇒ a brief delivered;
  skipped without the flag) and surfaced in `--status` — see
  `apps/cli/src/commands-daemon.test.ts`. No model required — the brief
  composes deterministically from structured data.
- [x] **P27-2 Briefing names upcoming birthdays.** The daemon brief now
  passes a `birthdayLine` from the user's contacts
  (`queryContacts` → `resolveUpcomingBirthdays` → `formatBirthdayBriefLine`).
  Proven: a contact whose birthday is today appears in the delivered
  brief — `apps/cli/src/commands-daemon.test.ts`.
- [x] **P27-3 Briefing covers calendar events.** The daemon brief now
  merges `deriveCalendarBriefingImminent` over the calendar registry's
  `listEvents` into its imminent set, so an imminent calendar event
  appears in the brief alongside tasks. Proven: an event 5 min out is
  surfaced in the delivered brief — `apps/cli/src/commands-daemon.test.ts`.
  **P27 complete: the resident daemon's brief covers objectives,
  imminent tasks + calendar, birthdays, and a related note.**

## Delivered — P26 (widen the daemon's perception reach)

Brought home-watch (HA entity states, read-only) + the due-reminders
tick into `muse daemon` — 7 ticks in one process. Audited PASS
(README ledger, `P26 audit`).

- [x] **P26-1 Home Assistant entity-state watch in the launcher.** The
  daemon runs a read-only home-watch tick (HA entity states via
  `homeWatchesFromConfig`, same `createWebWatchRunner` + sink), active
  with `MUSE_HOME_WATCH_CONFIG` + HA creds. A watched entity reaching a
  rule state (e.g. door "unlocked") fires a notice; never acts on the
  home (outbound-safety). Proven by a contract-faithful CLI smoke (a HA
  `/api/states` snapshot fires the notice; skipped without config) and
  surfaced in `--status` — `apps/cli/src/commands-daemon.test.ts`.
- [x] **P26-2 Due-reminders tick in the launcher.** The daemon fires
  due reminders (`runDueReminders`, always-on like proactive — no model
  needed) so the resident process covers the full proactive set
  (proactive · reminders · followup · ambient · web-watch · objectives ·
  home-watch = 7 ticks). Proven: a due pending reminder is delivered to
  a contract-faithful sink, a future one isn't; reported by `--status`
  — `apps/cli/src/commands-daemon.test.ts`.

## Delivered — P25 (ambient context fusion: Perception × Knowledge)

Ambient notices carry a "Related:" line from the user's real notes
about the active window. Audited PASS (README ledger, `P25 audit`).

- [x] **P25-1 Ambient notices carry a "Related:" line.** The daemon's
  ambient runner accepts a knowledge enricher; a fired ambient notice
  is enriched with a `— Related: …` line keyed on the active
  window/app. Proven by a contract-faithful CLI smoke: an injected
  enricher's line rides the delivered ambient notice; absent → plain
  notice — `apps/cli/src/commands-daemon.test.ts`.
- [x] **P25-2 Real enricher from the user's corpus.** The daemon builds
  the ambient enricher best-effort at startup from
  `createKnowledgeEnricher` (notes dir + local Ollama embed,
  hybrid+MMR) when `MUSE_BRIEFING_RELATED_KNOWLEDGE_ENABLED`; fail-soft
  to plain notices otherwise. Live-verified: over a temp notes dir,
  `enrich("Q3 budget memo")` returned the real `notes/q3-budget.md`
  line (not the parking decoy) — the daemon's exact builder. Seam +
  default-off tested in `apps/cli/src/commands-daemon.test.ts`.

## Delivered — P24 (Knowledge grounding quality: MMR)

Diversified knowledge_search top-K with MMR (best-effort on real
paraphrases; deterministic on exact duplicates). Audited PASS
(README ledger, `P24 audit`).

- [x] **P24-1 MMR diversification.** `rankKnowledgeChunks` gains an
  opt-in `diversify` path applying Maximal Marginal Relevance
  (Carbonell & Goldstein, SIGIR 1998) over the ranked candidates —
  `λ·relevance − (1−λ)·max-similarity-to-picked` — so a near-duplicate
  passage doesn't crowd out a distinct relevant one. Both
  `knowledge_search` surfaces use it. Proven: plain top-2 returns two
  near-duplicates; MMR returns one duplicate + the distinct passage —
  `packages/agent-core/test/knowledge-recall-agent.test.ts`. No dep,
  deterministic, local.
- [x] **P24-2 Tune/verify MMR on the real corpus (live).** Live
  nomic-embed measurement on a real near-duplicate corpus: λ=0.7 never
  dropped a paraphrase (both surfaced), so the default is lowered to
  **0.5**. Honest finding: even at 0.5 the dedup of real paraphrases is
  marginal — embedding jitter flips the thin MMR margin run-to-run — so
  MMR is kept as a best-effort diversity NUDGE, deterministically
  proven only on exact duplicates (`knowledge-recall-agent.test.ts`),
  not a guaranteed live paraphrase-dedup. No over-claim.

## Delivered — P23 (deepen Knowledge retrieval: hybrid RRF)

Cosine RAG fused with lexical keyword overlap via RRF across the
agent tool + corpus-search surfaces, recalling exact rare tokens the
embedding misses. Audited PASS (README ledger, `P23 audit`).

- [x] **P23-1 Hybrid (RRF) knowledge retrieval.** `rankKnowledgeChunks`
  gains an opt-in `hybrid` path fusing the cosine ranking with a
  lexical keyword-overlap ranking via Reciprocal Rank Fusion (Cormack,
  Clarke & Büttcher, SIGIR 2009); `knowledge_search` now uses it, so an
  exact rare token the embedding misses is still recalled. Proven: a
  corpus whose exact-keyword chunk has zero cosine is dropped by pure
  cosine but recalled by hybrid — `packages/agent-core/test/knowledge-recall-agent.test.ts`.
  No new dep, deterministic, local.
- [x] **P23-2 Hybrid in the corpus-search callers.** The
  `knowledge-corpus.ts` search paths — the situational-briefing
  `createKnowledgeEnricher` and the `createNotesKnowledgeSearchTool`
  corpus search — now rank via the hybrid path too. A zero-cosine
  exact-keyword chunk is recalled by the corpus-search tool; the
  lexical scorer drops stopwords so a decoy sharing only "my"/"is" is
  NOT falsely recalled — `packages/autoconfigure/test/knowledge-recall-sources.test.ts`.

## Delivered — P22 (the daemon runs for real on this Mac)

Composed the proven-once pieces into one launchable, observable
process and proved startup→delivery end-to-end. Audited PASS
(README ledger, `P22 audit`).

- [x] **P22-1a `muse daemon --once` proactive seam.** A user-facing
  CLI command launches the proactive tick in one process and returns
  after a single tick (the testable launcher seam, no infinite loop).
  Delivered + verified by a contract-faithful CLI smoke: an imminent
  task is delivered to a capturing messaging sink, a quiet tick sends
  nothing, an unknown provider fails closed (no send) — see
  `apps/cli/src/commands-daemon.test.ts`.
- [x] **P22-1b followup tick folded into the launcher.** `muse daemon
  --once` now runs the proactive AND followup ticks in one process; a
  DUE followup is synthesized + delivered to a contract-faithful sink
  (proactive-only cases stay hermetic; followups skip cleanly when no
  model resolves) — see `apps/cli/src/commands-daemon.test.ts`.
- [x] **P22-1c ambient tick folded into the launcher.** `muse daemon
  --once` now also runs the rule-based ambient perception tick; a
  matching ambient rule delivers a notice to a contract-faithful sink
  (skipped cleanly when no `MUSE_AMBIENT_RULES` configured) — see
  `apps/cli/src/commands-daemon.test.ts`.
- [x] **P22-1d web-watch tick folded into the launcher.** `muse daemon
  --once` now also runs read-only web-watch polling; an "appears"
  trigger over an injected fetch delivers a notice to a
  contract-faithful sink (skipped cleanly when no
  `MUSE_WEB_WATCH_CONFIG`) — see `apps/cli/src/commands-daemon.test.ts`.
- [x] **P22-1e objectives tick folded into the launcher.** `muse daemon
  --once` now also re-evaluates standing objectives and notifies on
  "met" — all FIVE ticks (proactive + followup + ambient + web-watch +
  objectives) run in one process. A MET objective notifies via a
  contract-faithful sink (skipped cleanly when no model) — see
  `apps/cli/src/commands-daemon.test.ts`.
- [x] **P22-1f SIGINT clean-shutdown smoke.** The `muse daemon`
  foreground loop now stops cleanly on SIGINT/SIGTERM via
  `DaemonStopSignal` (interruptible sleep — ctrl-c exits at once, no
  waiting out the interval; survives a throwing tick; no `process.exit`)
  — `runDaemonLoop` suite in `apps/cli/src/commands-daemon.test.ts`.
  **P22-1 (the launcher) is complete: all five ticks + clean shutdown.**
- [x] **P22-2 macOS active-window perception feeds the running
  daemon.** `muse daemon` now selects `MacOsActiveWindowSource` for
  its ambient tick when `MUSE_AMBIENT_SOURCE=macos` (darwin, or
  whenever a test injects the osascript runner). A contract-faithful
  osascript signal (`"Slack\ngeneral"`) drives exactly one notice on a
  matching rule through the real sink — see
  `apps/cli/src/commands-daemon.test.ts`.
- [x] **P22-3a chrome-source web-watch threading.** `muse daemon`
  threads a `ChromeSnapshotConnection` into `webWatchesFromConfig`, so
  a `source:"chrome"` watch reuses it and edge-fires; with NO
  connection the chrome watch is skipped fail-soft and the daemon
  stays up. Proven by a contract-faithful fake connection — see
  `apps/cli/src/commands-daemon.test.ts`.
- [x] **P22-3b real Chrome connection at daemon startup.** When
  `MUSE_CHROME_DEVTOOLS_ENABLED`, `muse daemon` builds the connection
  from the runtime assembly's `McpManager` (connect chrome-devtools →
  adapt `toMuseTools()` into a `ChromeSnapshotConnection` via
  `chromeSnapshotConnectionFromTools`), best-effort + fail-soft
  (disabled / connect-refused → `undefined` → chrome watches skip,
  daemon stays up). The adapter is contract-faithfully tested
  (adapts tools → drives a daemon chrome-watch edge-fire e2e); the
  literal browser handshake is verified manually, not in CI — see
  `apps/cli/src/commands-daemon.test.ts`.
- [x] **P22-4a `muse daemon --status` readiness report.** Prints which
  of the five ticks are enabled for the current config (proactive
  always; followup/objectives on a resolved model; ambient on
  `MUSE_AMBIENT_RULES`; web-watch on `MUSE_WEB_WATCH_CONFIG`) and
  exits without ticking — see `apps/cli/src/commands-daemon.test.ts`.
- [x] **P22-4b `muse daemon --init` config file.** Writes the resolved
  provider + destination to `~/.config/muse/daemon.json`
  (`MUSE_DAEMON_CONFIG_FILE` override); the launcher loads it with
  precedence flag > env > config > default, so the user persists them
  once instead of exporting env vars. Round-tripped by a CLI smoke
  (init writes → a later run with no flag/env reads + delivers) — see
  `apps/cli/src/commands-daemon.test.ts`. (Ambient-rules/watches in the
  config file remain a follow-on; provider/destination are the core.)
- [x] **P22-5 Full startup→delivery e2e gate.** A CLI smoke runs the
  full daemon with ALL five ticks enabled in one `--once` and proves
  each delivers to a contract-faithful sink (5 sends); a separate
  smoke proves a denied / timed-out provider send yields ZERO delivery
  (not marked fired — sidecar unpoisoned, history "failed"), the
  daemon stays up, no phantom send (`outbound-safety.md`) — see
  `apps/cli/src/commands-daemon.test.ts`.
- [x] **P22-6 launchd survival.** `muse daemon --install` writes a
  macOS LaunchAgent plist (`~/Library/LaunchAgents/com.muse.daemon.plist`,
  `MUSE_DAEMON_PLIST_FILE` override) with `RunAtLoad` + `KeepAlive` so
  the daemon survives logout/reboot, and prints the `launchctl load -w`
  line. The generated plist passes `plutil -lint` (the OS's own
  validator) — see `apps/cli/src/commands-daemon.test.ts`.

<!-- IMMUTABLE-CORE:BEGIN -->
## Immutable core (the loop must NEVER edit — honesty machinery)

Direction is the loop's to choose. These are NOT, and exist so
autonomy can't decay into busywork:

- the north-star definition (proactive + instantly-responsive
  personal assistant; the loop never weakens it),
- the falsifiable-outward test, the banned-shapes list,
- the `CAPABILITIES.md` rules + the requirement that every goal
  ship a green surface-level (not unit-only) automated check,
- the cross-iteration falsification + 10-iter regression sweep,
- never stop / never ask a human / never complete.

A commit-msg hook (`scripts/guard-immutable.mjs`) rejects any
change to lines in this block without `[core-change: human]`.
Changing the immutable core is a human-only action.
<!-- IMMUTABLE-CORE:END -->

The loop's enforced freedom: extend/reorder targets and bullets,
never the lines between the IMMUTABLE-CORE markers.
