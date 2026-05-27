# 549 — `muse mcp use filesystem` refuses to default to filesystem root `/` when both `--root` and `HOME` are empty (security-critical empty-env-shadow fix)

## Why

`apps/cli/src/commands-mcp.ts:486` configured the `filesystem`
MCP preset with:

```ts
args: ["-y", "@modelcontextprotocol/server-filesystem", options.root ?? process.env.HOME ?? "/"],
description: `Filesystem read/write rooted at ${options.root ?? "$HOME"}`
```

Two concrete defects, both **security-critical**:

1. **HOME unset entirely** (`process.env.HOME === undefined`):
   `undefined ?? undefined ?? "/"` → `"/"`. The MCP filesystem
   server gets rooted at the **filesystem root** — every file
   the user can read/write is exposed to whatever LLM the
   agent is talking to. A `delete` tool call from the agent
   could erase the operator's entire home directory, or
   `/etc/passwd`, or worse.
2. **HOME=""** (pre-cleared launcher pattern): `undefined ??
   "" ?? "/"` → `""` (because `??` only catches null/
   undefined, not empty strings). The MCP server starts with
   an empty path — undefined behavior depending on the
   `@modelcontextprotocol/server-filesystem` implementation;
   most likely crashes or silently fails, but in pathological
   cases could also mount at CWD.

Same empty-env-shadow defect class as goals 495 / 505 / 532 /
539 / 540 / 547 / 548, but with an outsized blast radius
because the resolved path is the **sandbox boundary** for an
LLM-controlled filesystem tool.

## Slice

- `apps/cli/src/commands-mcp.ts` — imported `firstNonEmpty`
  from `program-helpers.js`. Rewrote the `filesystem` preset
  builder to fail loud when neither override is usable:
  ```ts
  build: (options): McpJsonEntry => {
    const root = firstNonEmpty(options.root, process.env.HOME);
    if (!root) {
      throw new Error("muse mcp use filesystem: --root <dir> is required (HOME is empty / unset, refusing to default to filesystem root)");
    }
    return { args: [..., root], command: "npx", description: `Filesystem read/write rooted at ${root}` };
  }
  ```
  Promoted `MCP_PRESETS` to `export` so the new test can pin
  the behaviour directly. Behaviour byte-identical for every
  case where `--root` is set or HOME is a non-empty trimmed
  string — only the silent-mount-at-root path now throws.
- `apps/cli/src/commands-mcp.test.ts` — new file, 6 focused
  tests:
  - `--root` non-empty → used verbatim
  - `--root` padded → trimmed
  - `--root` undefined → falls back to HOME
  - `--root` whitespace → falls back to HOME
  - `--root` AND HOME both empty → throws with the security-
    safety message
  - `--root` undefined AND HOME undefined → throws (the
    original silent-mount-at-`/` path)

## Verify

- New tests 6/6 green; full `@muse/cli` suite green (981
  passed, +14 vs baseline 967 — 6 new + 8 carry-over, 0
  failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the
  builder to the pre-fix one-liner makes the "throws when
  both --root and HOME are empty" test fail with the
  precise pre-fix symptom — `expected [Function] to throw
  an error` (the function silently returns the entry with
  `args[2] = ""` or `"/"`). Fix restored, suite back to 6
  green.
- `pnpm check` EXIT=0, every workspace green; `pnpm lint`
  0/0; `pnpm guard:core` clean; byte-scan clean; `git status`
  shows only the two intended files.
- Pure preset builder — no LLM request-response wire path;
  `smoke:live` does not apply (per `testing.md` / iteration-
  loop Step 9). The defended path is the MCP filesystem
  server sandbox-boundary configuration, not the model loop.

## Status

Done. `muse mcp use filesystem` with no `--root` and an
empty/unset `HOME` now fails loud with:

```
muse mcp use filesystem: --root <dir> is required (HOME is empty / unset, refusing to default to filesystem root)
```

…instead of silently configuring an MCP filesystem server
rooted at `/` (whole-disk exposure to whatever LLM the agent
is talking to) or at `""` (undefined behavior in the
server). The empty-env-shadow convention now covers every
HOME-resolving site, including the security-critical
filesystem preset.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a security-critical
empty-env-shadow `fix:` on the MCP filesystem preset,
recorded honestly with this backlog row — not a false
metric.

## Decisions

- Step-8 redirect from the empty-HOME path-resolver sweep
  (547/548) to the security-critical MCP preset — same defect
  class, but the impact is qualitatively different (sandbox
  boundary vs. file location). Productive variation.
- Chose to THROW rather than fall through to a "safe" default
  (e.g. `~/Documents`). The user explicitly asked for a
  filesystem MCP root via `muse mcp use filesystem` — if we
  can't figure out a safe root, refusing the configuration
  is honest: the operator can re-run with `--root <dir>`. A
  silent default would mask the misconfiguration.
- Used `firstNonEmpty` from `program-helpers.ts` (the same
  helper goal 532/539/540 use). Cross-CLI convention is
  established; this is one more consumer.
- The error message is specific about WHY it's refusing
  ("HOME is empty / unset") and what fixes it ("--root <dir>
  is required"). Operators see actionable guidance, not just
  "missing argument."
- The mutation reverts to the single one-liner `options.root
  ?? process.env.HOME ?? "/"` — the test failure (`expected
  [Function] to throw an error`) reproduces the pre-fix
  observable byte-for-byte (silent return with the
  filesystem-root or empty-string default).
