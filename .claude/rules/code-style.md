# Code style & lint

The repo runs ESLint with `typescript-eslint/recommended` via the
flat config at the repo root (`eslint.config.js`). The gate is
intentionally permissive at first — most stylistic rules are off so
the existing codebase passes — and tightens iteratively.

## Commands

```bash
pnpm lint          # report only (warnings allowed, 0 errors required)
pnpm lint:fix      # auto-fix what eslint can fix safely
```

CI must keep `pnpm lint` exit-0. Warning count is the cleanup
backlog — don't let it grow unchecked.

## Currently enforced as `error`

- `no-debugger` — no `debugger;` left in committed code
- `no-eval` / `no-with` — defense against unsafe code paths
- `@typescript-eslint/no-unused-vars` — unused imports, params, and
  caught errors. Prefix with `_` to silence intentionally
  (e.g. `(_event) => ...`). Promoted in round 174 after the sweep.
- `prefer-const` — flag `let` declarations that are never
  reassigned. Promoted in round 174. The autoconfigure
  scheduler-handle pattern (closure forward-reference into a value
  assigned later) uses a `const { current }` holder object instead
  of `let`; reach for the same pattern when this rule complains.
- `no-empty` (with `allowEmptyCatch: true`) — promoted in round 181.
  Empty `catch {}` is fine; other empty blocks are bugs in waiting.
- `no-empty-pattern` — destructuring that binds nothing is almost
  always a typo.
- `no-useless-escape` — over-escaped regex/string characters.
- `no-unsafe-finally` — `return` / `throw` inside `finally` swallows
  the original control flow.
- `no-async-promise-executor` — `new Promise(async ...)` is the
  classic forgotten-await pattern.
- `no-prototype-builtins` — direct `obj.hasOwnProperty(...)` breaks
  on null-prototype objects; `Object.hasOwn(obj, ...)` is the
  modern fix.

## Off (but reconsider before tightening)

- `@typescript-eslint/no-explicit-any` — used in legitimate adapter
  shims; tightening requires per-file `eslint-disable` lines.
- `@typescript-eslint/no-empty-object-type` — JSON envelope types
  use `{}` legitimately.

## Adding a rule

When a recurring bug class shows up, add a single rule to
`eslint.config.js` and:

1. Run `pnpm lint --fix` if the rule has an autofixer.
2. Sweep remaining violations BEFORE merging the rule change.
3. Set the rule to `error` once the sweep is clean — `warn` is for
   the transition period only.

## Comments — write one ONLY when it is necessary

The default is **no comment**. A comment is a liability: it rots,
it lies eventually, and it costs every future reader (human or AI
agent) attention and context-window budget. Write one only when
the code cannot carry the information itself.

**Allowed (the WHY a reader cannot derive from the code):**

- A non-obvious constraint or invariant ("this API rejects 401 —
  never retry it; it is a permanent failure").
- A workaround whose reason is invisible ("upstream lib mutates
  the array; clone before passing").
- A deliberate, surprising choice ("strict `Number()` not
  `parseFloat` so `4h` is rejected, not silently 4").

**Forbidden — delete on sight:**

- **Round / iteration / goal markers.** `// Goal 158 —`,
  `// goal 070`, `round 167`, `added in iter #57`. The history
  lives in `git blame`, the commit message, and `CHANGELOG.md`.
  In source it is pure rot and noise. This is a hard rule.
- **WHAT narration.** `// loop over users`, `// increment count`,
  `// return the result` — the code already says this.
- **Task / PR / caller references.** `// used by the X flow`,
  `// added for issue #42`, `// see PR 1234`.
- **Restating the signature** in a docstring
  (`@param x the x value`).

**When in doubt, delete it.** If removing the comment loses
information a competent reader genuinely needs, rewrite it as one
short WHY line. Otherwise it goes.

`internal/goals/*.md` is where goal/iteration context belongs — never
in source comments.

## Naming

- **Names earn their length.** A two-character abbreviation that
  saves typing is a bad trade if a reader has to scroll up to learn
  it. Single-letter names belong only to obvious loop indices and
  `(a, b) => ...` comparators.
- **Re-stating history in comments** (`round 167`, `iter #57`,
  `Goal NNN`) belongs in commit messages and `CHANGELOG.md`, not
  source. See the comment rule above.
- **Re-export-only imports go away.** If `import { X } from "./y"` is
  paired with `export { X } from "./y"` and `X` isn't used in the
  file body, drop the `import` line — `export-from` covers it.
