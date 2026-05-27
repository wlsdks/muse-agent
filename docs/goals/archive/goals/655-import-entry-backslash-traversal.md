# 655 — `isSafeMuseEntry` (the `muse import` path-traversal gate) now rejects any entry containing a backslash so a Windows extractor — which treats `\` as a path separator — can't escape `~/.muse` via an entry like `.muse/foo\..\..\etc/passwd` that passes the existing split-by-`/` check

## Why

`apps/cli/src/commands-import.ts:isSafeMuseEntry` vets every
tarball entry the `muse import` command will restore. The
pre-fix predicate:

```ts
if (!entry.startsWith(".muse/") || entry.endsWith("/")) return false;
return !entry.split("/").some((segment) => segment === "..");
```

splits ONLY on `/`. On a Windows / cross-platform extractor
(where `\` is also a path separator), this is insufficient:

- `.muse/foo\..\..\etc/passwd` passes the check
  (`split("/")` produces `[".muse", "foo\..\..\etc", "passwd"]`
   — `"foo\..\..\etc"` is NOT `..` as a discrete segment).
- A Windows-aware extractor (or Node's path module on Windows)
  treats `\` as a separator → `.muse/foo/../../etc/passwd` →
  resolves to `<home>/etc/passwd`, escaping `~/.muse`.

Goal 238 established `isSafeMuseEntry` to prevent the classic
forward-slash traversal:

```
.muse/../../.ssh/authorized_keys
.muse/notes/../../../etc/cron.d/x
```

…but only on POSIX path-separator assumption. The backslash
variant — silent because Linux extracting the same tarball
treats `\` as a regular filename byte — only manifests on
Windows extraction.

**Threat model**:

- Muse export → tarball → cross-platform sharing → Windows
  user runs `muse import bundle.tar.gz`.
- Attacker crafts a tarball with `.muse/foo\..\..\etc/passwd`-
  shape entries.
- Pre-fix the entry survives the vetter, gets passed to
  `tar -xzf` as an explicit member, lands at
  `<home>/etc/passwd` (or similar escape) on Windows.
- Post-fix the entry is dropped at the vetter; `tar` never
  sees it.

Defense in depth — Muse's primary platforms are macOS/Linux,
where `tar` doesn't interpret `\`, but the import surface is
documented for cross-platform use (the export bundle is a
plain `.tar.gz` portable across systems).

### Defect class

**Path-traversal check missing alternative path separator
(Windows `\`)**. First hit. Fresh against the recent 10-iter
window:

- 654: PKCE (defense-in-depth feature)
- 653: recursion depth bound
- 652: error msg control-char sanitization
- 651: non-crypto RNG for security token
- 650: LLM timestamp sanity bound
- 649: unbounded HTTP body
- 648: HTTP fetch timeout
- 647: bracket parser inString
- 646: FIFO cap
- 645: file mode 0o600

Related to other "validate before trust" classes but a
distinct mechanism — alternate-separator-aware path traversal
check, not a numeric / value-range bound.

## Slice

- `apps/cli/src/commands-import.ts`:
  - Added `if (entry.includes("\\")) return false;` between
    the existing `startsWith(".muse/")` gate and the `..`
    segment check.
- `apps/cli/test/program.test.ts`:
  - Extended the existing `isSafeMuseEntry` describe with
    three new assertions:
    1. `.muse/foo\..\..\etc/passwd` → rejected (the canonical
       Windows-traversal shape).
    2. `.muse\notes\file.json` → rejected (entries using
       backslash as the sole separator, also dangerous).
    3. `.muse/has\backslash.json` → rejected (any embedded
       backslash, even without `..`, is rejected
       defensively).

## Verify

- `pnpm --filter @muse/cli test`: 1127 passed (no count
  change — added expects to an existing `it()` block rather
  than a new test). `pnpm check` full: every workspace
  green; tsc strict EXIT=0.
- **Clean-mutation-proven**: reverting the new
  `if (entry.includes("\\")) return false;` line makes
  EXACTLY the three backslash-traversal expects fail with
  the exact symptom (`false` expected, `true` received —
  the entry passed the vetter). The 14 pre-existing expects
  in the same test (legit pass, slash-only traversal,
  `..`-substring-not-segment, trailing-slash, empty, etc.)
  pass either way. Restored; all green.
- `pnpm lint`: 0 errors / 0 warnings.
- `pnpm guard:core`: clean.
- Byte-hygiene scan on the two touched files: clean.
- No LLM request/response wire path touched. `smoke:live`
  doesn't apply.

## Status

Done. A malicious tarball with backslash-laden entries can
no longer slip through the `muse import` vetter on any
extractor (Windows, MSYS2, future Node-native extraction):

| Bundle entry                              | Pre-fix `isSafeMuseEntry` | Post-fix                       |
| ----------------------------------------- | ------------------------- | ------------------------------ |
| `.muse/tasks.json` (legit)                | true                      | true (unchanged)               |
| `.muse/../../.ssh/authorized_keys`        | false                     | false (unchanged, slash-traversal) |
| `.muse/weird..name/x.json` (legit, `..` substring) | true              | true (unchanged)               |
| `.muse/foo\..\..\etc/passwd`              | **true** (escapes on Windows) | **false** (fixed)         |
| `.muse\notes\file.json`                   | true (escapes on Windows) | false (fixed)                  |
| `.muse/has\backslash.json`                | true                       | false (defensive)              |

## Decisions

- **Reject ANY backslash, not just suspicious patterns**.
  A surgical check (split-by-both-separators + segment
  test) would be more granular, but the cost of rejecting
  legitimate Linux filenames containing `\` (a rare edge
  case) is much smaller than missing a Windows-extraction
  escape. Muse's known stores (notes / calendar / tasks /
  reminders / followups / personas / feeds) don't use
  backslash in filenames.
- **Defense-in-depth, not a primary mitigation**. The
  extractor itself (`tar -xzf` on POSIX) doesn't interpret
  `\` as separator, so the bug is dormant today on
  macOS/Linux. But the `commands-import.ts` design comment
  explicitly says "the vetter is the second layer" — adding
  this check tightens that layer without weakening any
  other.
- **Inserted between `startsWith(".muse/")` and the
  segment-`..` check** so the function reads top-to-bottom
  as cheaper-to-more-expensive checks. `includes("\\")` is
  O(n) on the string; `split("/").some(...)` is O(n) plus
  allocations. Order doesn't affect correctness.
- **Did NOT add a `path-aware` normalisation pass** (e.g.,
  via Node's `path` module). The bundle list comes from
  `tar -tzf` verbatim; normalising would lose information
  about how the bundle author actually wrote the entry.
  The byte-level reject is the tightest fit.
- **Mutation choice**. Reverted only the new `if` line.
  The three new expects fail with the exact symptom; the
  14 pre-existing expects pass regardless. Surgical proof.

## Remaining risks

- **NUL bytes in entries**. `\0` in a filename is rejected
  by every modern filesystem at creation, but a hostile
  tar could carry an entry with embedded NUL that some
  extractors truncate at. Defensively reject? Out of scope
  for this iter; Linux/macOS file APIs already trip on NUL.
- **Unicode path-separator-like characters** (`U+FF0F`
  fullwidth solidus, `U+2044` fraction slash). A
  font-rendering attack could spoof a path. Not actually
  treated as separators by any filesystem I know of, but
  worth a future audit.
- **`tar -xzf` on Windows** with the explicit-members list:
  Git Bash / MSYS2 / WSL2 versions of tar SHOULD honor the
  member list, but a buggy / patched tar could ignore the
  filter and extract everything. Outside Muse's control;
  use a known-good tar.
- **Listing came from the same `tar -tzf` invocation** but
  extraction is a separate `tar -xzf` call. A TOCTOU race
  where the bundle is swapped between list and extract
  would defeat the vetter. Sibling-fixable by sha256-pinning
  the bundle between calls. Out of scope for this iter.
- **Bundle entries with control bytes** (ESC, BEL) survive
  the vetter but would appear in `io.stdout` listings.
  Goal 652's `formatErrorForTerminal` doesn't apply here
  (these aren't errors). A future iter could add a
  printable-only check.
