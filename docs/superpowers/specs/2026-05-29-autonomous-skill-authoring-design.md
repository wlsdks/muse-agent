# Autonomous Skill Authoring — end-of-session skill review

Status: design / approved-direction (approach A; scope hardened by self-review)
Date: 2026-05-29
Inspiration: Hermes Agent `background_review.py` (fork-and-review) + OpenClaw
`skill-workshop` (correction → pending skill). Both MIT — patterns studied, no
code copied.

## Why (honest adaptation)

Muse already has every *input* of self-improvement — the ReasoningBank
correction-distiller (`agent-core/correction-distiller.ts`), cross-session
reflection, a typed UserModel, plan-cache, CRAG — and a full SKILL.md system
(contract, filesystem loader, registry, progressive-disclosure exposure in
`chat-skills.ts`, and `muse.skills.list/read/run` tools). What it CANNOT do is
turn a learning into a durable, reusable **skill** the agent authors itself.
Today corrections become one-line playbook *strategies* (memory); nothing ever
becomes a *procedure*.

Hermes' whole differentiator is a post-turn review agent that decides what to
persist as a skill. We reproduce that engine the Muse way: **deterministic
detection + a single local-Qwen generalisation call, fail-soft, run at session
end** — mirroring the existing `distillSessionCorrections` rather than
inventing a new hook.

## Scope (what self-review settled)

The unified-engine direction (corrections AND successful complex tasks → skills)
is the north star. But the established learning hook is **end-of-session and
transcript-based** (`chat-ink.ts:1228-1252`): it reads `SessionTurnLine[]`
(role + content only) from disk and has **no per-turn tool-iteration count**.
So:

- **This slice (deliver now): correction → skill.** The reliable, available
  signal. Reuses the entire distiller pipeline and adds the skill arm.
- **Slice 2 (next): complex-success → skill.** Requires a deterministic
  complexity+success signal (tool-iteration count from run-history +
  "no following correction"). The `reviewSession` interface accepts a signal
  union so this drops in without rework. Deferred because a small local model
  is an unreliable self-verifier (arXiv 2404.17140) — we will NOT gate skill
  authoring on model self-judgement of success.
- **Slice 3 (follow-up C): curator.** Idle/periodic gardening (pin / archive /
  consolidate) of the authored library. Out of scope here.

A skill is usable the **next session** (the startup loader scans roots), exactly
like playbook strategies and episodes. No live mid-session registration in this
slice — that complexity is unnecessary and inconsistent with the existing hook.

## Memory vs skill — the boundary (avoids double-writing)

A correction stays a **playbook strategy** (memory) when it is a *preference /
working rule* ("prefer X over Y", "don't do Z") — the distiller already handles
these and keeps handling them unchanged. It additionally becomes an **authored
skill** ONLY when it reveals a *reusable multi-step procedure* ("when asked to
do W, the right way is: 1… 2… 3…"). The generalisation prompt returns `NONE`
for preference-style corrections, so the common case produces a playbook entry
and no skill; skills stay sparse and procedural.

## Constraints honoured

- **Execute-gate is fail-close (guard).** An authored skill NEVER declares
  `requires.bins`/`anyBins`; the store strips them at write. `muse.skills.run`
  already refuses a skill with no declared bins, so an authored skill can never
  gain binary-execution capability without a human promoting it. (`outbound-
  safety.md` posture: no new acting-capability autonomously.)
- **The review is fail-open (hook).** It runs after the answer, opt-in via
  `MUSE_SKILL_AUTHOR_ENABLED`, wrapped in `.catch(() => undefined)` — a flaky
  model or filesystem never blocks exit or corrupts the turn.
- **No shadowing of real skills.** Authored dir is loaded as the FIRST (lowest-
  precedence) root, so user/workspace/bundled skills override it ("later root
  wins"); the store also refuses to write a name that collides with any
  existing non-authored skill (suffixes on collision).
- **One local-Qwen call, deterministic everything else** — detection
  (`detectCorrections`), dedup (`strategyTextSimilarity`), create-vs-patch, and
  validation are code; only generalisation uses the model, one-shot.
- **Secret redaction** on the generalisation input (`redactSecretsInText`).
- **Local-first**: a JSON-free, file-per-skill store under `~/.muse/skills/
  authored/`; atomic fsync+rename, 0600 — same durability posture as
  `personal-plan-cache-store.ts`.

## Design

### 1. `packages/agent-core/src/skill-review.ts` (new — pure)

```ts
type SkillReviewSignal =
  | { kind: "correction"; exchange: CorrectionExchange }   // slice 1
  // | { kind: "complex-success"; ... }                     // slice 2 seam

interface SkillDraft { name: string; description: string; body: string }

// deterministic: classify which session turns warrant a skill review
detectSkillCandidates(turns: readonly SessionTurnLine[], opts?): readonly SkillReviewSignal[]

// one local-Qwen call → {name, description, body} or null ("NONE"/invalid)
draftSkillFromSignal(signal, { modelProvider, model, redact? }): Promise<SkillDraft | null>
```

- `detectSkillCandidates` reuses `detectCorrections`; caps per session
  (default 2, like the distiller).
- `draftSkillFromSignal` system prompt (opinionated, Hermes-style): "Return a
  reusable SKILL only when the correction reveals a multi-step PROCEDURE.
  Output `NONE` for one-off preferences. Generalise — do not restate the
  exact content." Structured output `name | description | body`; deterministic
  parse + validate (mirrors `parseDistilledStrategy`). The model does NOT
  decide create-vs-patch (that is the store's job).

### 2. `packages/skills/src/authored-skill-store.ts` (new)

```ts
interface AuthoredSkillStoreOptions { dir?: string; maxSkills?: number; existingNames?: () => readonly string[] }
class AuthoredSkillStore {
  writeOrPatch(draft: SkillDraft): Promise<{ skill: Skill; action: "create" | "patch" | "skip" }>
  listAuthored(): Promise<readonly Skill[]>
}
```

- **Execute-gate**: writes frontmatter `{ name, description, metadata: { muse:
  { authored: true, authoredAt } } }` — never `requires`.
- **create-vs-patch-vs-skip (deterministic)**: if the draft's name/description
  is ≥ threshold similar (`strategyTextSimilarity`, default 0.6) to an existing
  authored skill, replace that skill's body (`patch`) — unless the body is byte-
  identical, then `skip` (idempotent no-op write). Otherwise `create`. Removes
  the hard decision from the small model.
- **collision guard**: if the chosen name equals a non-authored skill name,
  suffix `-learned` / `-learned-2`. `existingNames` is injected best-effort from
  the caller's loaded registry (non-authored skills); even when it returns `[]`,
  the authored-first-root precedence (§3) still prevents shadowing a real skill.
- **cap**: `MAX_AUTHORED_SKILLS` (default 30 — conservative; every authored
  skill adds an index line the local model reads each turn). On overflow,
  move the oldest to `authored/.archive/` — never delete (curator-ready).
- Writes `~/.muse/skills/authored/<slug>/SKILL.md`; atomic fsync+rename, 0600.

### 3. `packages/autoconfigure` — loader root + path resolver

- `resolveAuthoredSkillsDir(env)` (`MUSE_AUTHORED_SKILLS_DIR`, default
  `~/.muse/skills/authored/`).
- `buildSkillRegistry`: prepend `{ path: authoredDir, source: "authored" }` as
  the FIRST root (lowest precedence). Add `"authored"` to `SkillSource`.

### 4. `apps/cli/src/chat-author-skills.ts` (new) + wiring

- `authorSkillsFromSession(opts): Promise<AuthorResult>` — mirrors
  `distillSessionCorrections`: injectable `readLines`/`readBoundaries`,
  `extractCurrentSessionTurns`, fail-soft, typed skip reason. For each detected
  signal: `draftSkillFromSignal` → `AuthoredSkillStore.writeOrPatch`; collect
  authored/patched names.
- `chat-ink.ts:1228-1252`: add a third end-of-session step guarded by
  `MUSE_SKILL_AUTHOR_ENABLED` (default false), `.catch(() => undefined)`,
  surfacing `💾 Learned skill: <name>` lines. A manual `muse skills author`
  command (sibling of `muse playbook distill`) for on-demand runs.

## Verification

- `agent-core/test/skill-review.test.ts`: `detectSkillCandidates` (correction
  present / none / cap); `draftSkillFromSignal` (procedure → draft, preference
  → null via `NONE`, invalid → null, fake provider — no real model).
- `skills/test/authored-skill-store.test.ts`: write/read round-trip;
  **execute-gate** (a draft carrying `requires` → stored with none);
  create-vs-patch by similarity; name-collision suffixing; cap → archive
  (never delete); atomic-write/tolerant-read.
- `skills/test/skill-loader.test.ts` (extend): authored root is overridden by a
  same-named user skill (precedence).
- `apps/cli/src/chat-author-skills.test.ts`: end-to-end with fakes — a
  correction session authors a skill; a no-correction session skips; fail-soft
  on read error.
- **eval:tools** golden case: with an authored procedural skill present, a
  later matching prompt → local Qwen SELECTS/follows it; an unrelated prompt →
  not injected (negative case). The outward proof per `tool-calling.md` — a
  skill the model never selects is not delivered.
- **smoke:live** (LOCAL OLLAMA QWEN): a correction turn → `authorSkillsFrom
  Session` writes a SKILL.md → a follow-up turn surfaces it via
  `selectRelevantSkills`. Tagged `[UNVERIFIED-LIVE]` only if Ollama is down.
- Gates: `pnpm --filter @muse/agent-core test`, `pnpm --filter @muse/skills
  test`, `pnpm check`, `pnpm lint` (0/0).

## Falsifiable outward test (the metric)

"After the user corrected Muse on a multi-step procedure, Muse authored a
SKILL.md from it; on a later similar request it selected and followed that
authored skill." Exercised by the eval:tools + smoke:live cases above.

## Out of scope

- complex-success → skill (slice 2; needs tool-count plumbing).
- The curator (slice 3 / option C).
- Live mid-session registration (next-session pickup is consistent + enough).
- Server-surface trigger (logic lives in `agent-core`/`skills` so the API can
  adopt it later; only the CLI end-of-session hook is wired now).

## CAPABILITIES.md line (on delivery)

`- [Autonomy] Muse authors a reusable SKILL.md from a procedural user
correction at session end (fork-and-review, after Hermes) — execute-gated,
deduped, capped to ~/.muse/skills/authored/, picked up next session and
selected by the local model on a similar request — skill-review.test.ts +
authored-skill-store.test.ts + chat-author-skills.test.ts + eval:tools +
smoke:live — self-improvement slice`
