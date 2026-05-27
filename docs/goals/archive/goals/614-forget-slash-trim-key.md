# 614 — `/forget <key>` slash command trims surrounding whitespace before lookup, mirroring the `/fact` and `/pref` trim already in place; whitespace-only arg shows usage instead of falling through to "no memory"

## Why

`apps/cli/src/chat-repl-slash.ts:handleSlashCommand("forget", …)`:
the wipe-all sentinel was already case-insensitive +
whitespace-tolerant (`arg.trim().toLowerCase() === "--all"`), but
the per-key path used the raw `arg`:

```ts
const k = arg;
if (!ctx.userMemory) { /* ... */ }
const factHit = ctx.userMemory.facts[k];
```

So a user typing `/forget   foo  ` (extra spaces from a hurried
keystroke, a speech-to-text artifact, a copy-paste from a Markdown
list with leading whitespace) silently looked up `facts["  foo  "]`
— `undefined` — and got `(key '  foo  ' not in memory)` even
though the fact `foo` was sitting right there. The sibling
`/fact key=value` and `/pref key=value` handlers (line 154-155)
trim both sides; the wipe-all sentinel (line 280) trims the
sentinel before matching. The per-key `/forget` path was the only
asymmetric site.

A whitespace-only arg (`/forget   `) was even more confusing
pre-fix: `arg.length > 0` (it's 3 chars), so the outer
empty-arg guard passed. The sentinel branch didn't match. `k`
became `"   "`, looked up in `userMemory.facts` → undefined. The
user got `(key '   ' not in memory)` for a clearly-meaningless
input — no usage hint.

Step-8 redirect: not boolean-spelling (612), not Date overflow
(613), not validation-gate (610/611), not finite-clamp (609).
Same defect family as goal 603 (CLI empty-id guards on
`muse persona use`) but on a different surface (REPL slash
command, not top-level commander argument). 603 was 11 commits
back; fresh enough.

## Slice

- `apps/cli/src/chat-repl-slash.ts`:
  - Replaced `const k = arg;` with `const k = arg.trim();`
    followed by an empty-key guard:
    ```ts
    if (k.length === 0) {
      io.stdout(`(usage: /forget <key> | /forget --all)\n`);
      return;
    }
    ```
  - The trimmed `k` now flows through to the lookup AND the
    wipe + rebuild compare below (lines compare
    `fk !== k`, `pk === k || pk === \`veto:${k}\` || ...`), so
    a padded input correctly skips the matching original key
    in the rebuild step.
  - Same usage-text style as the sibling `/fact` / `/pref`
    handlers ("usage: /<cmd> ...") for visual parity.
- `apps/cli/src/chat-repl-slash.test.ts`:
  - Two new tests in the existing `/forget` describe:
    - **Padded-key trim** — seeds memory with `fact.foo=bar`,
      calls `/forget "  foo  "`, asserts the output contains
      `(forgot foo)` AND that the underlying store's
      `factsInStore` map no longer has `foo` after the wipe +
      rebuild. Pre-fix the test catches the lookup miss with
      the exact `(key '  foo  ' not in memory)` symptom.
    - **Whitespace-only arg** — calls `/forget "   "`, asserts
      the output contains `usage: /forget <key>` and that no
      `deleteByUserId` call fired. Pre-fix the test would
      catch the `(no memory for u)` fall-through (the
      pre-fix path hit the userMemory-undefined branch
      instead of showing usage).

## Verify

- `@muse/cli` suite green (1046 passed, +2 vs the iter-start
  baseline of 1044, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting `k = arg.trim()`
  + the empty guard back to `k = arg` makes the new padded-key
  test fail with the exact pre-fix `(key '  foo  ' not in memory)`
  symptom (vs the expected `(forgot foo)`). The whitespace-only
  test would similarly fail on the "usage" assertion.
- `pnpm check` EXIT=0 (apps/api 258 passed, apps/cli 1046
  passed, every workspace green); `pnpm lint` 0/0; `pnpm
  guard:core` clean; byte-scan clean on both touched files;
  `git status` shows only the two intended files plus this
  goal doc.
- No LLM request-response wire path touched; `smoke:live` does
  not apply. The slash dispatcher is in-process REPL handling,
  not HTTP surface.

## Status

Done. The `/forget` per-key path now follows the same
whitespace posture as its siblings:

| Input            | Before                                  | After                       |
| ---------------- | --------------------------------------- | --------------------------- |
| `/forget foo`    | exact-match lookup, works               | unchanged                   |
| `/forget` (no arg)| usage hint (outer guard)               | unchanged                   |
| `/forget --all`  | wipes (sentinel already trim'd)         | unchanged                   |
| `/forget --All`  | wipes (case-insensitive sentinel)       | unchanged                   |
| **`/forget   foo  `**| **`(key '  foo  ' not in memory)`** | exact-match after trim (**fixed**) |
| **`/forget   `** (whitespace only) | **`(no memory for u)`** | usage hint (**fixed**) |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a CLI UX
consistency `fix:` on the REPL slash dispatcher, recorded
honestly with this backlog row — not a false metric.

## Decisions

- **Trim early, validate, then proceed.** The pattern matches
  the `/fact` / `/pref` handlers above (which trim then check
  `length === 0`). One uniform shape across the three
  key-taking slash commands makes the dispatcher easier to
  audit.
- **Whitespace-only shows the same usage text** as the bare
  no-arg case the outer guard already handles. A different
  message ("key must not be blank") would split the user's
  mental model — same cause (didn't provide a real key),
  same hint.
- **The trimmed `k` flows through the wipe-rebuild compare**
  (`fk !== k`, `pk === k || pk === \`veto:${k}\` || ...`).
  Without trimming `k` consistently, an asymmetry would
  surface: lookup uses trimmed, rebuild uses raw → rebuild
  would re-insert the to-be-deleted fact under its trimmed
  name. Single source of truth.
- **No change to the wipe-all sentinel.** Already trimmed,
  already case-insensitive — left exactly as goal-568
  established.
- **Mutation choice.** Reverted exactly the four lines that
  introduce the trim + empty guard. The mutation reproduces
  the pre-fix shape — the realistic regression a maintainer
  might write while "removing the trim because /forget --all
  already trims sentinel-side, no need to trim again." The
  mutation test catches that misjudgment with the exact
  `(key '  foo  ' not in memory)` symptom.
- **Two tests, not one.** The padded-key test pins the
  load-bearing trim. The whitespace-only test pins the
  usage hint path (the empty-check after trim, which the
  padded-key test alone wouldn't differentiate from the
  trim-only fix). Together they bracket the contract.

## Remaining risks

- **Other slash commands** with raw-arg lookups weren't
  audited in this iter. `/persona`, `/model` may have
  similar untrimmed-key paths; spot-check in a follow-up
  iter if a real case surfaces.
- **Multi-word keys** (`/forget some fact`) still get
  treated as a single key `"some fact"` after trim — same
  as before. The `/fact key=value` parser splits on `=`;
  `/forget` doesn't have an equivalent boundary marker, so
  the input is the whole key.
- **The wipe-rebuild compare** is O(N) per call where N is
  the user's full memory size. For a user with thousands
  of facts, each `/forget <key>` re-upserts every other
  fact one-by-one. Performance concern, not a correctness
  one; out of scope here.
