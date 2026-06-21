---
name: release
version: 1.0.0
description: Use when 진안 wants to cut a Muse release / tag a version — "릴리스 찍어줘", "release 만들자", "v0.2 내자", "버전 올려줘", or asks which version number is next. Decides the next SemVer number from the commits per docs/VERSIONING.md, verifies the build is releasable, then bumps + changelogs + commits + tags + pushes + creates the GitHub Release (pre-release while 0.x). Muse-specific.
---

> **Versioning.** This skill carries a `version` (above). Bump it (patch = wording,
> minor = a new step/rule, major = a changed gate) whenever you edit this file or
> the policy it enforces ([`docs/VERSIONING.md`](../../../docs/VERSIONING.md)).

# release — cut a Muse version the same way every time

## Overview

One invocation cuts **one** release: decide the number → prove it's releasable →
bump, changelog, commit, tag, push → create the GitHub Release. The single
source of truth for *what a number means* is
[`docs/VERSIONING.md`](../../../docs/VERSIONING.md) — this skill is its
executable form. If the two ever disagree, the doc wins; fix this skill.

**Releases are deliberate, human-cut milestones — never automated per commit.**
`main` iterates continuously (autonomous loops included), so a release is a
snapshot of a chosen *known-good* commit, not a reaction to every push.

## Step 0 — orient

```bash
git fetch origin main
git describe --tags --abbrev=0 2>/dev/null || echo "(no tag yet — first release is v0.1.0)"
gh release list 2>&1 | head
```

Read the last tag. The current series is decided by `docs/VERSIONING.md`.

## Step 1 — decide the next number (per docs/VERSIONING.md)

List the commits since the last tag and classify them:

```bash
git log --oneline "$(git describe --tags --abbrev=0 2>/dev/null || git rev-list --max-parents=0 HEAD)"..origin/main
```

While the major is **`0`** (the beta era — no `-beta` suffix, GitHub release flagged
pre-release):

| Commits since last tag contain… | Bump | e.g. |
| --- | --- | --- |
| A new user-visible capability/surface (`feat:`) | **MINOR** | `0.1.0 → 0.2.0` |
| Only `fix:`/`refactor:`/`chore:`/`docs:` (no new capability) | **PATCH** | `0.1.0 → 0.1.1` |
| A breaking change to a public surface (CLI / `MUSE_*` / `~/.muse` format) | **MINOR** + loud note | `0.2.0 → 0.3.0` |

For the jump to **`1.0.0`**, do NOT just bump — verify the five-point stability
gate in `docs/VERSIONING.md §The 1.0.0 gate` is fully met first; if a QA window
is wanted, cut `v1.0.0-rc.1` instead. `alpha`/`beta`/`rc` suffixes are ONLY for
the runway into a specific major, never during `0.x`.

State the chosen number and the one-line reason before proceeding.

## Step 2 — prove it's releasable (the only real gate)

A release is a promise that a fresh clone works. Verify on a known-good commit
(see [`README §Verification`](../../../README.md#-verification)):

```bash
cd /tmp && rm -rf muse-rel && git clone --depth 1 https://github.com/wlsdks/Muse.git muse-rel && cd muse-rel
pnpm install        # must wire build scripts with NO "approve-builds" step and NO error
pnpm build          # all packages Done, 0 errors
pnpm test           # all packages pass in isolation (concurrent local loops can cause
                    #   stale-dist / load-timeout flakes — re-run a flaky file alone;
                    #   a clean fresh clone is the source of truth)
```

If Ollama + `gemma4:12b` are up, also confirm a live round-trip
(`node apps/cli/dist/index.js doctor` then a `muse ask`). **A failure that
reproduces on a clean fresh clone blocks the release; a failure that only
appears under local concurrent-loop load does not** (prove it by re-running the
file in isolation — see the loop-saturation note in the testing rules).

## Step 3 — bump, changelog, commit, tag, push

Work on `origin/main`'s tip (rebase your release commit onto it; `main`
churns). Stage with **explicit paths** (other loops may have files staged).

1. **Bump** root `package.json` `version` → the chosen number. (Workspace
   `packages/*` stay `private` + `0.0.0`; not published to npm — root version is
   the single source of truth.)
2. **CHANGELOG** — promote `## [Unreleased]` items into a new
   `## [X.Y.Z] - YYYY-MM-DD` section (Keep a Changelog). Get today's date from
   the environment / `currentDate`, never guess it.
3. **Commit**: `chore(release): vX.Y.Z` (paths: `package.json CHANGELOG.md`).
4. **Rebase** onto `origin/main` if it moved (`git fetch` then `git rebase
   origin/main`), resolving the changelog if a loop touched it.
5. **Tag** annotated: `git tag -a vX.Y.Z -m "vX.Y.Z"`.
6. **Push** with approval (per `commits.md` never push without it — the user
   asking for a release IS that approval): `git push origin main && git push
   origin vX.Y.Z`. The `pre-push` grounding tripwire runs; a battery that
   stalls SKIPs (fail-open), only a RUN+FAIL blocks. Never `--no-verify` /
   `MUSE_SKIP_PREPUSH=1` without asking.

## Step 4 — create the GitHub Release

```bash
gh release create vX.Y.Z \
  --title "vX.Y.Z — <short theme>" \
  --notes "<from the CHANGELOG section>" \
  --prerelease            # ALWAYS while the major is 0; drop only at 1.0.0+
  # --latest=false        # add for a -rc or a back-patch that isn't newest
```

Notes = the new CHANGELOG section, plus a one-line "early/experimental, macOS
only" caveat while in `0.x`.

## Step 5 — report

Report: the version + why that bump, the verification result (what passed /
what was a known local flake), the tag + release URL, and anything deferred.

## Guardrails

- **Never auto-release per commit.** One deliberate snapshot at a time.
- **`--prerelease` is mandatory while major = 0.** Dropping it claims stability
  Muse hasn't promised yet.
- **Don't fake the gate.** If a fresh clone won't build/test, fix that first —
  a release whose install is broken is worse than no release.
- **Don't bump to `1.0.0` casually** — it's a stability promise; meet the gate.
- The policy lives in `docs/VERSIONING.md`. Change the rule there first, then
  mirror it here and bump this skill's `version`.
