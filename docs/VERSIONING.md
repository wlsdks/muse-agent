# Versioning & releases

Muse follows [Semantic Versioning 2.0.0](https://semver.org/). This file is
the contract for what a version number means and when a release is cut. Read
it before tagging anything.

## TL;DR

- **`0.x` IS the beta.** Major version `0` already means "initial development,
  anything may change" — so we do **not** append `-beta`. While the major is
  `0`, every GitHub Release is flagged **pre-release**.
- **`0.MINOR.0`** (`0.2.0`, `0.3.0`, … `0.9.0`) — a release that adds a new
  user-visible capability or surface (any `feat:`). This is the normal march.
- **`0.x.PATCH`** (`0.1.1`, `0.1.2`) — fixes / perf / docs / internal hardening
  only, **no new capability** (`fix:` / `refactor:` / `chore:`).
- **`1.0.0`** — cut only when the stability gate below is fully met.
- Releases are **deliberate, human-cut milestones**, never automated per commit.

## Why `0.x` and not `-beta`

Per the SemVer spec, a major version of `0` "is for initial development —
anything MAY change at any time; the public API SHOULD NOT be considered
stable." That is exactly what a beta is, so stacking `0.1.0-beta` on top is
redundant noise. Muse signals "still stabilising" with the `0.` major **and**
the GitHub pre-release flag. `alpha` / `beta` / `rc` suffixes are reserved for
the runway into a *specific* major (see [Pre-release runway](#pre-release-runway)).

## Which number moves (while in `0.x`)

The change drives the bump — and we already write [Conventional
Commits](https://www.conventionalcommits.org/), so the mapping is mechanical:

| The release contains… | Bump | Example |
| --- | --- | --- |
| A new user-visible capability or surface (`feat:`) | **MINOR** | `0.1.0 → 0.2.0` |
| Only fixes, perf, docs, refactors, deps (`fix:`/`refactor:`/`chore:`/`docs:`) | **PATCH** | `0.1.0 → 0.1.1` |
| A breaking change to a public surface | **MINOR** + a loud note | `0.2.0 → 0.3.0` |

> While the major is `0`, a breaking change bumps MINOR (you cannot bump major
> without committing to `1.0`). Call it out explicitly under a **Changed
> (breaking)** heading in the release notes so users aren't surprised.

"Public surface" for Muse = the `muse` **CLI commands**, the documented
**config / env vars** (`MUSE_*`), and the **on-disk store formats** under
`~/.muse`. Changing any of those in a breaking way is a breaking change.

## The `1.0.0` gate

`1.0.0` is a promise: *the public surface is stable and Muse is
production-ready for its supported platform.* Cut it only when **all** hold:

1. **Fabrication = 0 stays CI-gated.** The grounding / citation invariant is
   enforced in code and the grounded-surface count has never regressed across
   releases (it is already a release gate — keep it one).
2. **One-shot install.** A fresh clone reaches its first private, cited answer
   with no manual recovery step, on every **supported** platform.
3. **Stable public surface.** CLI commands, `MUSE_*` config, and `~/.muse`
   store formats are stable enough to promise: no breaking change without a
   major bump.
4. **Supported platforms are declared and solid.** (macOS today; Windows is
   planned. `1.0` declares its supported set — it does not require every
   platform, only that the declared ones are reliable.)
5. **Onboarding + docs are complete** enough that a new user succeeds unaided.

There is a real failure mode of *never leaving `0.x`* — a project that works
fine but won't commit to "stable." When the five points above hold, ship
`1.0.0`; don't hide behind `0.x` out of habit.

## Pre-release runway

`alpha` / `beta` / `rc` suffixes are only for the approach to a **specific**
major (chiefly `1.0.0`), when a QA window is wanted before the final tag:

- `v1.0.0-rc.1` — believed stable; rigorous testing before the real `1.0.0`.

We do **not** use `-alpha` / `-beta` during `0.x` — the `0.` major already
carries that meaning.

## How a release is cut (checklist)

Releases are cut **by hand** at a chosen commit — never on every push.
`main` iterates continuously (including autonomous loops), so an
auto-release-per-commit would produce dozens of meaningless tags a day. A
release is a deliberate snapshot of a *known-good* commit.

1. **Pick a known-good commit** — one where fresh-clone `install → build →
   test` and a live local round-trip pass (see [`README`](../README.md#-verification)).
2. **Bump `version`** in the root `package.json` to the new number. (Workspace
   `packages/*` stay `private` + `0.0.0`; they are not published to npm, so the
   root version is the single source of truth for the release.)
3. **Move the CHANGELOG** — promote `## [Unreleased]` items into a new
   `## [X.Y.Z] - YYYY-MM-DD` section (Keep a Changelog format).
4. **Commit** (`chore(release): vX.Y.Z`), then **tag** annotated `vX.Y.Z`.
5. **Push** the commit and the tag.
6. **Create the GitHub Release** from the tag — **pre-release flag ON while the
   major is `0`** — with notes drawn from the CHANGELOG section.

## Not published to npm

Muse ships as an application, not a library. Every `@muse/*` workspace package
is `private` and is **not** published to npm — there is no per-package semver
to maintain. The version that matters is the **git tag + GitHub Release** of
the whole product.
