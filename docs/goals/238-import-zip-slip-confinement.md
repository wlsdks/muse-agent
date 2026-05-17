# 238 — `muse import` zip-slip: blanket tar extract escapes ~/.muse

## Why

`muse import <bundle>` (restore a `muse export` backup) carried a
real arbitrary-file-write vulnerability. `commands-import.ts` read
the manifest with `tar -tzf`, filtered it to `.muse/`-prefixed
files, ran the collision / `--force` prompt on that filtered list,
then extracted with:

```ts
spawn("tar", ["-xzf", bundlePath, "-C", home]);  // EVERY member
```

The `.muse/` filter was display-only. `tar -xzf … -C $HOME` with no
member arguments extracts **every** archive entry, so the filter
never constrained what hit disk. The file's own comment promised a
"hand-rolled tar with extra junk can't sneak files into unrelated
directories" — that guarantee was false. Two reachable escapes from
an untrusted bundle (a downloaded / shared "backup", or one an
attacker convinces the user to `muse import`):

- **No `..` needed** — a top-level member like `.bashrc` or
  `.ssh/authorized_keys` lands directly in `$HOME` under
  `tar -C $HOME`, silently **overwriting** it. It is never in the
  vetted `.muse/` list, so the collision check and `--dry-run`
  never mention it and `--force` is not required.
- **Path traversal** — `.muse/../../.ssh/authorized_keys` starts
  with `.muse/` (so the old filter even *listed* it) yet escapes
  the target directory on a non-hardened `tar`.

The safety prompt protected only the cosmetic `.muse/` subset; the
actual extraction was unconfined.

## Scope

`apps/cli/src/commands-import.ts`:

- New pure, exported `isSafeMuseEntry(entry)` — an entry is restored
  only when it starts with `.muse/`, is not a directory entry
  (trailing `/`), and has no `..` path segment. `..` as a substring
  inside a segment (`weird..name`) is fine; `..` as a whole segment
  is rejected. `listMuseImportEntries` now filters through it, so
  the manifest / collision / dry-run surface is provably confined.
- `extractMuseBundle(bundlePath, home, entries)` now passes the
  vetted list to tar as **explicit members**
  (`tar -xzf bundle -C home -- <entry>…`). Naming the members
  confines tar to exactly the list the collision check already
  showed — junk and traversal entries in the archive are ignored by
  tar itself, deterministically, regardless of GNU-tar vs bsdtar
  default `..` behaviour. The action's existing
  `entries.length === 0` early-return guarantees tar always gets at
  least one member (an empty member list would fall back to
  extract-everything).
- The misleading file/function comment is rewritten so the stated
  guarantee is the one now actually enforced.

`extractMuseBundle` is exported for direct test coverage (same
posture as `listMuseImportEntries` / `findImportCollisions`).

## Verify

- `pnpm --filter @muse/cli test` — 552 pass (was 550; +2). New:
  (1) `isSafeMuseEntry` pure-predicate table (legit `.muse/` files
  accepted; `.muse/../../.ssh/...`, `.muse/..`, `.bashrc`,
  `/etc/passwd`, dir entries, empty rejected; `weird..name`
  accepted); (2) an integration test that builds a real malicious
  `.tar.gz` (a legit `.muse/keep.json` plus a `..`-free top-level
  `pwned.txt`), asserts `listMuseImportEntries` excludes the escape
  entry, then runs `extractMuseBundle` and asserts `keep.json` was
  restored while `pwned.txt` was **not** written into the home dir.
  This test fails against the pre-fix blanket extract.
- `pnpm check` — every workspace build+test green (apps/cli 552,
  apps/api 153, all packages).
- `pnpm lint` — exit 0.
- No real-LLM request/response path touched (this is the `tar`
  restore path), so no Qwen round-trip applies.

## Status

done — restoring an untrusted `muse export` bundle can no longer
write outside `~/.muse`. Extraction is confined to the exact
traversal-safe member list the collision / `--force` prompt
surfaced, so the safety prompt now actually governs what lands on
disk, and the `.muse/` filter is enforcement rather than decoration.
