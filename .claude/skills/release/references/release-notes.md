# Release-notes & version-decision rubric

The depth behind the `/release` skill. Two jobs, both mechanical-first:
**(A) decide the number** from the commit history, and **(B) turn the whole
commit history since the last tag into release notes a user actually wants to
read.** Follow this every time so the output is identical-quality regardless of
who (or which model) runs it.

---

## A. Decide the number (deterministic)

Run this — it is the single input for the whole decision:

```bash
LAST=$(git describe --tags --abbrev=0 2>/dev/null || git rev-list --max-parents=0 HEAD)
git log --no-merges --pretty='%h%x09%s' "$LAST"..origin/main
```

Then apply the rules **top to bottom; first match wins**:

1. **Empty?** No commits (or only `chore(release):` / `docs(loops)` journal
   churn) → **STOP, nothing to release.** Don't cut an empty tag.
2. **Going to `1.0.0`?** Only if 진안 asked AND the five-point gate in
   `docs/VERSIONING.md` is met. Otherwise never auto-jump to `1.0.0`.
3. **Breaking change?** Any commit whose subject has a `!` before the colon
   (`feat!:`, `fix!:`, `refactor!:`) OR any body/footer line matching
   `BREAKING CHANGE:` →
   ```bash
   git log "$LAST"..origin/main --pretty='%B' | grep -qiE '(^|\s)BREAKING CHANGE|^[a-z]+(\([^)]*\))?!:' && echo MINOR
   ```
   → **MINOR** (`0.MINOR+1.0`). A breaking change to the **public surface**
   only — the `muse` CLI commands, documented `MUSE_*` env vars, or the
   on-disk `~/.muse` store formats. An internal refactor with no user-visible
   contract change is **not** breaking → stays PATCH.
4. **Explicit milestone?** 진안 said "milestone로 찍자" / "0.2 내자" / "minor로
   올려줘" → **MINOR** (deliberate marker).
5. **Otherwise → PATCH** (`0.x.PATCH+1`). This is the default for everything
   else — fixes, features, perf, docs, refactors. **The patch number climbs and
   never resets** (`0.1.1 → 0.1.2 → … → 0.1.200`), exactly like Claude Code's
   `2.1.157`. A `feat:` alone does NOT escalate to minor.

> Why patch-by-default: this is `release-please`'s pre-`1.0` behaviour
> (`bump-patch-for-minor-pre-major` + `bump-minor-pre-major`). A minor bump
> resets patch to `0` and restarts the climb, so it is reserved for the two
> escalators above.

State the result as: `vX.Y.Z → vX.Y.Z'  (PATCH/MINOR — <one-line reason>)`.

---

## B. Write the notes (analyse the WHOLE history since the last tag)

The notes are not a commit dump. They are a curated, user-facing story built
from **every** commit since the last tag.

### B1. Gather everything

```bash
LAST=$(git describe --tags --abbrev=0)
git log --no-merges --pretty='%h%x09%s%x09%an' "$LAST"..origin/main
```

Read all of it. Do not sample — 진안 wants the full history reflected.

### B2. Filter out non-user noise

Drop these lines entirely (they are process, not product):

- `chore(release):` (the release commits themselves)
- `docs(loops)` / anything touching only `docs/goals/loops/**` (loop journals)
- pure CI/tooling `chore:` with zero user-facing effect
- `Merge ...` (already excluded by `--no-merges`)

If a single squashed commit clearly bundles many changes, expand it into the
distinct user-facing bullets it represents.

### B3. Classify each surviving commit

| Conventional prefix | Keep-a-Changelog heading |
| --- | --- |
| `feat:` | **Added** |
| `fix:` | **Fixed** |
| `perf:` | **Performance** |
| `refactor:` / `chore:` with a user-visible effect | **Changed** |
| anything with `!` / `BREAKING CHANGE` | **Changed (breaking)** — at the top |
| `docs:` with user value (new guide) | **Documentation** (optional) |

Omit a heading that has no entries. Drop internal-only `refactor:`/`test:`/
`chore:` that a user would never notice.

### B4. Rewrite each into a user-facing bullet (the craft)

A commit subject is written for developers; a release note is written for
**users**. Rewrite, don't paste:

- **Lead with the user benefit, not the mechanism.**
  - commit `fix(recall): clamp cosine fallback floor to 0.18` →
    note `Fixed cross-language recall occasionally surfacing an unrelated note.`
- **Plain language, no internal symbol names** unless user-facing (a CLI flag,
  an env var, a command are fine; an internal function name is not).
- **One bullet per distinct user-visible change.** Merge duplicates; collapse a
  fix-up commit into the feature it fixes.
- **Imperative, present, concise.** "Add", "Fix", "Speed up" — one line each.
- **Group trivia.** Many tiny fixes → one bullet: "Various stability and
  reliability fixes."
- **Flag breaking changes loudly** at the very top with the migration in one
  line: "**Breaking:** `muse foo` is now `muse bar` — update scripts."

### B5. Write the headline

Open the section with **one or two sentences** naming the theme of the release
(what a user gets), before the categorized lists. Example:

> Faster local recall and a calmer proactive daemon, plus the macOS companion
> now survives sleep/wake.

### B6. Assemble

```markdown
## [X.Y.Z] - YYYY-MM-DD

<one–two sentence headline>

### Changed (breaking)   ← only if any; always first
- **Breaking:** …

### Added
- …

### Fixed
- …

### Performance
- …
```

Promote any standing `## [Unreleased]` hand-written items into the right
headings too, then leave `## [Unreleased]` empty for the next cycle. Get the
date from the environment / `currentDate` — never guess it.

### B7. GitHub Release body

The `gh release create --notes` body = the CHANGELOG section, plus:
- a one-line "early/experimental, macOS only" caveat while major = `0`,
- a link back to `CHANGELOG.md#xyz` and the README quick-start.

---

## Quality bar (what "A+" means here)

A release is A+ when **all** hold:

- The number follows section A exactly (patch climbs; minor only on the two
  escalators) — and the one-line reason is stated.
- Every user-facing commit since the last tag is represented; every non-user
  commit is filtered out.
- No raw commit subjects survive — each bullet reads as a user benefit.
- Breaking changes are at the top with a one-line migration.
- A newcomer reading only the notes understands what changed and why it matters.
- `--prerelease` is set while major = `0`; the fresh-clone gate (scaled to the
  bump) passed.
