# internal/goals — the work-selection compounding ledger (the work ledgers)

> The name is historical residue (the "goal number" era). What it actually is: **the place
> where "what to build next / what got built / why we dropped it" survives across sessions**.
> Never read any file whole — they are all retrieval indexes (grep for the section you need).

## Active ledgers — written and consumed by the skills

| file | writer | reader (consumer) | contents |
|---|---|---|---|
| `backlog.md` | improve-muse (adds/removes [open]), scout (records for=improve-muse), grow (debt records) | **improve-muse** rung 4 | **open only**: [open] · [decision] · [blocked] · [rejected] (lifecycle split 2026-07-17) |
| `backlog-archive.md` | improve-muse/grow's completed ✓ lines (moved here from backlog on completion) | grep target for freshness guard/dedup | done/superseded/exhausted history (append-only) |
| `growth-backlog.md` | scout (`[scout date]` rows) | **grow-muse** rung 4 (build rows only; done-marking is also grow) | capability-opportunity reservoir (231 base + scout deltas) — **keeps its own row format, not subject to record grammar/checker (explicit exception)** |
| `judgment-lens.md` | (created then frozen 2026-06-23) | scout's judgment criteria doc (fit/verdict/edge precedents, incl. ⛔51 skip) | Muse-identity lens |
| `rival-watch.md` | **scout only** | next scout (watermark is the delta fence) | roster/shelf (~/ai clones, licensing, 🚨khoj AGPL), fire log |

One-line flow: **scout fills the two backlogs → grow/improve consume and flip ✓ →
rival-watch remembers where the next scout starts.**

> 2026-07-17 rename: `capability-parity-backlog.md` → `growth-backlog.md`,
> `capability-parity-judgment.md` → `judgment-lens.md` (old names in the archive/past
> commits point to these files).

## Full inventory of skill output artifacts (this is all of it)

- **In-repo (md 3+1):** writes to `backlog.md`·`growth-backlog.md`·`rival-watch.md`,
  `judgment-lens.md` is a read-only lens (frozen 2026-06-23). The skills create no other md.
- **In-repo (not md):** the code/test commits themselves (improve/grow slices — verification
  evidence lives in the commit body), and the skill docs themselves (`.claude/skills/*`).
- **Outside the repo:** `~/ai/<name>` rival clones (scout; kept via fetch), `docs/self-eval-scoreboard.json`
  (gitignored local — ORIENT's `pnpm self-eval` records it indirectly), session memory notes (the
  agent's own record, not a skill contract).

## Archive / design docs — not written by the skills

- `competitor-teardown.md` — 2026-06-23 exhaustive competitor teardown (do not re-scout, read-only reference doc)
- `loops/` — **only active loops** carry a fire journal. `loops/INDEX.md` is the single map (a
  retired loop keeps only its row, journal deleted — preserved in git history; cleaned up 2026-07-18). A new journal
  MUST add a row. `prompt-system.md` is an active journal still used in Jinan-direct mode even after the loop ended.
- `attunement-implementation-plan.md`, `attunement-slice-b-safety-contract.md` —
  human-directed design/planning docs (a closed planning doc is deleted — remaining items become backlog records)
- `attunegraph-roadmap.md` — **separate active long-running program.** Researches/builds/dogfoods
  Shadow Muse·Continuity Capsule·Policy Card and the
  agent-native **AttuneGraph** in stages, without duplicating Core100/legacy-300's
  general foundation work.
- `personal-agent-successor-roadmap.md` — **current authoritative execution doc.** Core100-100
  concluded with the decision `continue-with-successor`, so PA-S001..S008 is the live order; the
  next task, lane, gate, and model choice follow this doc.
- `personal-agent-core-100-roadmap.md` — **superseded, kept for its slice definitions and
  `legacyRefs`.** It re-composed the remaining core into 100 ≤20-minute slices and its program is
  finished; do not activate from it. Both files claimed `active-authoritative` until 2026-07-30,
  which pointed agents at completed work.
- `personal-agent-productization-roadmap.md` — historical reference for the 300-task legacy
  requirements and stable IDs. Not used for new BUILD/EVIDENCE activation; consult a section only
  when detailed rationale from Core100's `legacyRefs` is needed.

## Accumulating (ledger-style) docs outside `goals` — for a complete map (full 2026-07-17 survey)

Docs outside this directory also accumulate a record. All of them are **their own format, not
subject to record grammar/checker** (an explicit exception, like growth-backlog):

| file | nature |
|---|---|
| `../../docs/strategy/positioning/competitor-analysis-and-a-plus-roadmap.md` | **closed 2026-07-30** — kept only for the residual §10.3 items and the §11 queue; new rival findings go to `rival-watch.md` |
| `docs/strategy/agent-research-findings-2026.md` | research ledger (edited in place) |
| `../../docs/strategy/positioning/differentiation.md` · `security-sweep-2-plan.md` | closed ledgers (see the status stamp at the top) |
| `CHANGELOG.md` (root) | release log — Keep-a-Changelog, curated by the release skill |
| `.claude/skills/loop-creator/CHANGELOG.md` | skill version ledger |

Closed ledgers, audit snapshots, and handoff instances are **deleted by default** (Jinan directive
2026-07-18 — git history preserves them; leaving them around makes agents keep habitually
appending). Audit evidence goes in the commit body — don't create a new separate evidence-ledger md.

## Concurrency (2026-07-17, based on public research)

The three ledgers (backlog·growth-backlog·rival-watch) auto-resolve parallel-append conflicts via
`.gitattributes`'s **`merge=union`** (several loops/worktrees writing concurrently is routine —
it's git's official driver, applies under rebase too, RED→GREEN reproduction verified). Known
trade-off: fixing the same line concurrently can produce a **duplicate line** instead of a
conflict → the curation rule catches it. If concurrent writers grow much further, the next step
is a GitLab-style **entry-per-file split** (item=file, status=directory move; prior art in the
git-bug/ripissue family) — overkill for now, not adopted.

## Record template (2026-07-17 Jinan directive — analyzable data)

Every top-level `- ` line in backlog.md·backlog-archive.md follows this grammar
(enforced by `scripts/check-ledger-format.mjs` as a self-eval gate):

```
- [status] YYYY-MM-DD key=value ... :: free-form description (title/body)
  continuation detail indented 2 spaces (multiple lines allowed, free prose)
```

- **status** (word only): `open` needs doing · `done` complete · `blocked` blocked ·
  `decision` awaiting human decision · `rejected` rejected (do not re-propose) · `superseded` superseded
- **fields** (only if present, space-separated): `commit=<sha>` `kind=<fix|feat|test|docs|guard|scout>`
  `src=<probe|scout|owner|loop|audit>` `prio=<1-5>` `gate="before->after"`
  `for=<improve-muse|grow-muse>`
- **no emoji/decorative symbols** (math symbols allowed). Arrows are `->`.
- analysis example: `grep '^- \[done\]' | ...` pulls date·commit·gate-delta directly.
- **enforcement**: commit-msg hook + self-eval gate (`check-ledger-format.mjs`) — grammar, forbidden
  symbols, closed `kind` set, (for `[done]` dated after 2026-07-18) required commit=, no indented records.
- **scope**: backlog.md + backlog-archive.md only. growth-backlog (its own row format)·rival-watch
  (watermark format)·judgment-lens (frozen) are explicit exceptions. Historical records from before
  2026-07-18 remain fieldless text data (the archive is a move commit, so git-blame dates can't be recovered).

## Curation rule (applies to every ledger)

Compress a completed item into one line with its delta, and remove at least one stale line every
time you add one (net growth ≈ 0). An unboundedly growing ledger becomes noise that blurs the
judgment of the next pick.
