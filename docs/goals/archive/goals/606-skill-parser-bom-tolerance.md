# 606 — `splitFrontmatter` strips a leading UTF-8 BOM so a SKILL.md saved by a BOM-prepending editor (Windows Notepad, some macOS tools) parses correctly instead of throwing "missing required name"

## Why

`packages/skills/src/skill-parser.ts:splitFrontmatter` opens a
SKILL.md, splits on `\r?\n`, and tests the first line against
`/^---\s*$/u`. The intent is: "the file starts with a YAML-style
frontmatter delimiter, followed by key/value lines, then a
closing `---`."

Pre-fix the first line was tested verbatim. A UTF-8 BOM byte
(`U+FEFF`) at position 0 — silently prepended by Windows Notepad,
the default macOS TextEdit save flow under some encodings, and a
handful of cross-platform editors when "encode with BOM" is on —
sits before the `---`, so `lines[0] === "U+FEFF---"`. The regex
expects `^---` at position 0; the BOM at position 0 fails the
anchor.

`splitFrontmatter` then falls back to "no frontmatter, body =
whole file" (the malformed-file recovery path). `parseSkillFile`
receives an empty `parsedFrontmatter`, sees `parsedFrontmatter.name`
is `""`, and throws:

```
SkillParseError: SKILL.md missing required "name" field
```

The author looks at the file in their editor, sees `name: github`
right there at the top, and has no diagnostic to tell them the
actual problem is one invisible byte at position 0.

Step-8 redirect: not finite-guard (595/596), not 0o600 (598/599),
not boolean-spelling (585/587/597), not timeout (600), not regex-
coverage (601), not Invalid-Date (602), not CLI empty-id (603),
not memory-cap (604), not dedup-parity (605). Defect class is
"text-encoding tolerance at file ingestion" — fresh.

## Slice

- `packages/skills/src/skill-parser.ts:splitFrontmatter`:
  - First action of the function: if `raw.charCodeAt(0) === 0xfeff`,
    slice the BOM off into a `stripped` local. Both the lines
    split AND the fallback `body: stripped` branch use the
    stripped value so the body never carries a stray BOM into
    `Skill.body` either.
  - One-line change; the rest of the function is unchanged.
- `packages/skills/test/skill-parser.test.ts`:
  - One new test in the `parseSkillFile` describe. Writes a
    SKILL.md whose contents are `U+FEFF` + the existing
    `OPENCLAW_STYLE_SKILL` fixture. Asserts `parseSkillFile`
    returns the parsed skill with `name === "github"` and the
    nested `requires.bins === ["gh"]` — i.e. the entire
    OpenClaw frontmatter parses through cleanly.
  - The literal BOM byte is forbidden by the repo's byte-scan
    rule (`\x{feff}` is on the deny list), so the test uses the
    `U+FEFF` escape sequence in the template literal instead.

## Verify

- `@muse/skills` suite green (11 passed, +1 vs baseline 10, 0
  failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the BOM
  strip in `splitFrontmatter` makes the new test fail with
  `SkillParseError: SKILL.md missing required "name" field` —
  the exact pre-fix symptom thrown from line 41-42 of
  `parseSkillFile`. Fix restored, suite back to 11/11.
- `pnpm check` EXIT=0 (apps/api 258 passed, apps/cli 1041
  passed, every workspace green); `pnpm lint` 0/0; `pnpm
  guard:core` clean; byte-scan clean on both touched files
  (the BOM in the test source is the escape sequence
  `U+FEFF`, not the raw byte); `git status` shows only the
  three intended files (src, test, this goal doc).
- No LLM request-response wire path touched; `smoke:live`
  does not apply. Skill ingestion isn't HTTP-exercised by
  `smoke:broad` either — the loader runs at process startup
  off the filesystem.

## Status

Done. SKILL.md ingestion now tolerates the BOM byte that
real-world editors silently add:

| File source                                    | Before                                    | After                       |
| ---------------------------------------------- | ----------------------------------------- | --------------------------- |
| UTF-8 without BOM (`vim`, most modern editors) | parsed correctly                          | unchanged                   |
| UTF-8 with BOM (Notepad, some macOS workflows) | **threw "missing required name"**         | parses correctly (**fixed**)|
| Empty / malformed frontmatter                  | fail-open → "missing name"                | unchanged                   |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a robustness /
input-tolerance `fix:` on the skill loader, recorded honestly
with this backlog row — not a false metric.

## Decisions

- **`raw.charCodeAt(0) === 0xfeff`, not `raw.startsWith("U+FEFF")`.**
  `charCodeAt` reads one code unit and compares it to an integer
  literal — no string allocation, no regex compile, no Intl
  surprises. The BOM is exactly one UTF-16 code unit (0xFEFF), so
  the single-position check is sufficient and matches the
  threat-model exactly: "the byte at position 0 is a BOM."
- **Strip BOM at `splitFrontmatter`, not at `parseSkillFile`.**
  The two entry points to the parser are `parseSkillFile` (reads
  from disk) and `parseSkillFrontmatter` (callers test
  frontmatter strings directly). Doing the strip inside
  `splitFrontmatter` means BOTH paths benefit, and the function's
  invariant becomes "the input is treated as if BOM-free." If a
  future caller introduces a third path, it gets the same
  tolerance for free.
- **`body: stripped` in the fallback branch**, not `body: raw`.
  A malformed-frontmatter file with a BOM would otherwise carry
  the BOM into `Skill.body` even though every other code path
  saw the stripped version. Keeping the body BOM-free even on
  fail-open means downstream consumers (markdown renderers, body
  diffing, snapshot tests) don't have to know about BOMs at all.
- **Don't strip other zero-width / format characters.** Only the
  UTF-8 BOM has the "silently added by editors" pathology. ZWJ /
  ZWNJ / ZWSP showing up in a frontmatter file would be a
  legitimate authoring choice (some non-Latin scripts depend on
  them in identifiers). Scope-limited fix.
- **Mutation choice.** Reverted exactly the two relevant edits
  (the strip itself, and the body fallback). The mutation
  reproduces the pre-fix shape — that's the realistic regression
  a maintainer might introduce while "simplifying the
  function back to one line."
- **Test uses the `U+FEFF` escape, not the literal byte.** The
  repo's verification step 9 includes a byte-scan that flags
  `\x{feff}` in source as forbidden (it's a real
  invisible-character hazard). The TypeScript escape sequence
  parses to the same code unit at runtime but is harmless in
  source. The test was originally written with the literal byte,
  the byte-scan flagged it, and the in-place edit replaced it
  with the escape — the scan is now clean.

## Remaining risks

- **UTF-16 BOMs (FE FF / FF FE)** aren't handled. Those would
  arrive as decoded `U+FEFF` (or trigger a UTF-8 decode error)
  because `fs.readFile(..., "utf8")` is told to read the file as
  UTF-8. A SKILL.md genuinely saved as UTF-16 would fail
  upstream of this code anyway. Out of scope.
- **BOM in the middle of the file** — e.g. concatenated files —
  is not stripped. The fix only addresses position 0. A BOM
  appearing mid-file as a zero-width-no-break-space is a
  legitimate (if rare) authoring decision and shouldn't be
  silently stripped.
- **`splitFrontmatter`'s open-no-close fallback** still includes
  the opening `---` line as the first line of body. That's a
  pre-existing fail-open quirk, separate concern.
- **Other parsers in the repo** (TOML config, JSON sidecar
  files) aren't audited for BOM tolerance here. If one of them
  has the same gap a future iter can lift the same one-line
  pattern.
