# General-purpose tools for Muse — design spec (Claude-Code-style file/shell/web)

Status: **SLICES 1–2 SHIPPED** (2026-06-16) — `@muse/fs` package with
`file_read` (path/line + PDF/Word/image, supersedes the old `@muse/mcp`
3-folder reader), `file_list`, `file_grep`, `file_write`, `file_edit`,
`file_multi_edit`; path sandbox (home + deny-list); fail-close write
approval gate; wired into `muse ask --with-tools`. Proof: 59 unit tests +
`eval:tools` fs scenarios **16/16 STABLE 3/3** on gemma4:12b; full
`pnpm check` + `pnpm lint` green. **Slice 3 (`web_search` + `MUSE_WEB_EGRESS`)
remains** (§6 — confirm the switch approach first). `run_command` (Bash) and
`web_read` (WebFetch) already existed.

Goal: give Muse the granular,
general-purpose toolset that lets it freely read/modify the local
machine — the way Claude Code has `Read/Write/Edit/MultiEdit/Bash/Grep/
Glob/WebFetch/WebSearch` — without breaking the two things that make
Muse *Muse*: the local-model one-shot tool-calling constraint and the
local-only grounding/citation edge.

## 0. The core tension, resolved

Claude Code runs on a frontier model and can expose ~10 undifferentiated
tools at once. Muse runs on **gemma4:12b local**, where `tool-calling.md`
caps the *per-turn* set at ≤5–7 and forbids confusable pairs.

The resolution is **register many, expose few**: the existing
`DefaultToolExposurePolicy` (`packages/tools/src/index.ts`) already trims
the full registry to a relevance-ranked `maxTools` subset per turn via
`ToolExposureContext` + `compareToolExposurePriority`. So we CAN ship the
full granular set (the user's "각자 만들어야 유연하다" instinct is
correct) — the model just never *sees* all of them at once.

What the exposure policy ALREADY enforces (verified in code):
- `risk === "execute"` (or `scopes: ["local"]`) requires `localMode: true`, else `local_execution_unavailable`.
- `risk === "write"` requires `isWorkspaceMutationPrompt(prompt)`, else `write_without_mutation_intent`.
- repeat-call cap via `recentToolNames` (`repeat_limit_exceeded`).
- `maxTools` hard cap (`max_tool_count_exceeded`).

So this design adds tools + TWO new deterministic guards (path sandbox,
web egress) and reuses everything else.

## 1. The catalog

| Claude Code | Muse tool | risk | domain | status |
|---|---|---|---|---|
| Read | `file_read` | read | filesystem | NEW |
| Glob | `file_list` | read | filesystem | NEW |
| Grep | `file_grep` | read | filesystem | NEW |
| Write | `file_write` | write | filesystem | NEW |
| Edit | `file_edit` | write | filesystem | NEW |
| MultiEdit | `file_multi_edit` | write | filesystem | NEW (split — see §3) |
| Bash | `run_command` | execute | system | **EXISTS** (`runner.ts`, via `crates/runner`) |
| WebFetch | `web_read` | read* | web | **EXISTS** (`@muse/mcp`) |
| WebSearch | `web_search` | read* | web | NEW (local-only gated — §6) |

`read*` = read-risk but **network egress**, which is the special case
local-only mode must refuse (§6).

Naming follows `tool-calling.md` (verb_noun, one job, no homonyms).
Deliberate disambiguation of the classic confusable triple:
`file_read` (one file's bytes) vs `file_list` (find files **by name/path
pattern**) vs `file_grep` (find **by content** regex). Three distinct
verbs, no overlap.

## 2. Per-tool specs

Each schema follows `tool-calling.md`: explicit `required`, concrete
example in every `description`, tightest type/enum/range, no abbreviated
names. All paths are validated against the sandbox root (§4) before use.

### `file_read` (read)
> Read the full text of ONE local file. Use when the user refers to a
> specific file by path/name and you need its contents. Do NOT use to
> find files (use file_list) or to search inside files (use file_grep).
```jsonc
{ "path":   { "type":"string", "description":"Absolute or workspace-relative path, e.g. '/Users/me/notes/todo.md'" },
  "offset": { "type":"integer", "minimum":1, "description":"Optional 1-based start line, e.g. 200" },
  "limit":  { "type":"integer", "minimum":1, "description":"Optional max lines to read, e.g. 100" },
  "required": ["path"] }
```
Returns `{ path, content, totalLines, truncated }`. **Grounding:** result
carries `source = path` so `file_read` output is a citeable source (§7).

### `file_list` (read) — Glob
> Find files whose PATH matches a glob. Use to locate files by name when
> you don't know the exact path, e.g. 'all my markdown notes'. Do NOT use
> to search file contents (use file_grep).
```jsonc
{ "pattern": { "type":"string", "description":"Glob, e.g. '**/*.md' or 'src/**/*.ts'" },
  "cwd":     { "type":"string", "description":"Optional base dir, e.g. '/Users/me/notes'" },
  "limit":   { "type":"integer", "minimum":1, "maximum":1000, "description":"Max paths, e.g. 100" },
  "required": ["pattern"] }
```

### `file_grep` (read) — Grep
> Search the CONTENTS of files for a regex. Use to find which files
> contain a string/pattern, e.g. 'where did I write about the dentist'.
> Do NOT use to find files by name (use file_list).
```jsonc
{ "pattern": { "type":"string", "description":"Regex, e.g. 'dentist|치과'" },
  "path":    { "type":"string", "description":"Optional dir or file to scope, e.g. '/Users/me/notes'" },
  "glob":    { "type":"string", "description":"Optional file filter, e.g. '*.md'" },
  "mode":    { "type":"string", "enum":["files","content"], "description":"'files' = matching paths only; 'content' = matching lines with line numbers" },
  "required": ["pattern"] }
```

### `file_write` (write) — Write
> Create a new file or fully overwrite an existing one. Use ONLY when the
> user clearly asks to create/save/replace a file. For small changes to an
> existing file, prefer file_edit. Overwrites are gated (approval — §5).
```jsonc
{ "path":    { "type":"string", "description":"Target path, e.g. '/Users/me/notes/draft.md'" },
  "content": { "type":"string", "description":"Full file contents to write" },
  "required": ["path","content"] }
```

### `file_edit` (write) — Edit (single)
> Replace ONE exact piece of text inside an EXISTING file. The file must
> already exist (use file_write to create). old_string must match exactly
> and be unique unless replace_all. For several edits to the same file in
> one shot, use file_multi_edit.
```jsonc
{ "path":        { "type":"string", "description":"File to edit, e.g. '/Users/me/notes/todo.md'" },
  "old_string":  { "type":"string", "description":"Exact text to find (must be unique unless replace_all)" },
  "new_string":  { "type":"string", "description":"Replacement text" },
  "replace_all": { "type":"boolean", "description":"Replace every occurrence (default false)" },
  "required": ["path","old_string","new_string"] }
```

### `file_multi_edit` (write) — MultiEdit (batch)
> Apply SEVERAL exact-text replacements to ONE existing file, in order.
> Use only when you have 2+ edits to the same file; for a single change
> use file_edit. Each edit's old_string must match exactly.
```jsonc
{ "path":  { "type":"string", "description":"File to edit, e.g. '/Users/me/notes/todo.md'" },
  "edits": { "type":"array", "minItems":1, "items": {
      "old_string": { "type":"string", "description":"Exact text to find" },
      "new_string": { "type":"string", "description":"Replacement text" },
      "replace_all": { "type":"boolean", "description":"Replace every occurrence (default false)" },
      "required": ["old_string","new_string"] } },
  "required": ["path","edits"] }
```

### `web_search` (read, egress) — WebSearch
> Search the public web for current information Muse can't find locally.
> Use only when the answer needs fresh external facts. REFUSED under
> local-only mode (the default). Do NOT use for anything in the user's
> own files/notes (use file_grep / knowledge_search).
```jsonc
{ "query": { "type":"string", "description":"Search query, e.g. 'TypeScript 5.7 release date'" },
  "limit": { "type":"integer", "minimum":1, "maximum":10, "description":"Max results, e.g. 5" },
  "required": ["query"] }
```

(`run_command` and `web_read` already exist — no schema change; they just
join the catalog.)

## 3. Edit/MultiEdit — SPLIT (decided: 1:1 Claude Code parity)

**Decision: split into `file_edit` + `file_multi_edit`** for literal
Claude Code parity. The cost we accept: `file_edit` vs `file_multi_edit`
is a confusable pair on the local model, so it gets an explicit
confusable-set eval (§9) — "change this one line" must pick `file_edit`,
"make these three changes" must pick `file_multi_edit`. Disambiguation
lives in the descriptions ("ONE exact piece" vs "SEVERAL … 2+ edits") and
the `edits[]` array shape (only `file_multi_edit` has it). If the eval
shows gemma4 can't separate them reliably, the fallback is to merge — but
we ship split first and let the eval decide.

## 4. NEW guard: path sandbox (deterministic, fail-close)

**Decided scope: whole home dir (`~`) allowed, governed by a deny-list.**
This maximizes "freely control my Mac"; the deny-list is the safety floor.
A new `resolveWithinRoots(path, roots, denyList)` in the fs package:
- canonicalizes (resolve symlinks, collapse `..`) BEFORE any fs op.
- **allow root = `~` (home)** plus the current workspace, overridable via
  `MUSE_FS_ROOTS`. A path resolving outside every root → throw, fail-close.
- **deny-list (always wins, even inside `~`)** — these are refused even
  though they live under home: `~/.ssh`, `~/.aws`, `~/.config/muse` &
  `.muse/` (Muse's own secrets/state), `~/Library/Keychains`,
  `~/.gnupg`, `~/.config/gh` & other credential stores, anything matching
  `*token*`/`*secret*`/`*credential*`/`.env` by default. Extensible via
  `MUSE_FS_DENY`. A denied path → throw, fail-close, logged.
- any path outside roots OR matching the deny-list → throw. No
  "best-guess" path; ambiguity is a refusal, not a guess.

Because the allow-root is broad (`~`), the **deny-list is the real
security boundary** — its unit battery is the critical test (every
sensitive path above must be refused; traversal/symlink escape out of `~`
must be refused; an ordinary `~/notes/x.md` must pass).

This is code, not prompt — same posture as `local-only-policy.ts`.
Ships with a unit test battery (traversal `../`, symlink escape, denied
sensitive path, allowed in-root path).

## 5. Write/execute approval gate (reuse existing seam)

`file_write`, `file_edit`, `run_command` are state-changing → route the
`ToolApprovalGate` (`{ risk, toolCall } → { allowed, reason }`) fail-close:
deny/timeout ⇒ **no mutation**. NOTE this is a *local file* change, so
`outbound-safety.md` draft-first does NOT apply (that's for sends toward a
third party) — risk-based approval is the right bar. The acceptance test
asserts deny/timeout leaves the file **unchanged** (agent-testing.md #3,
no partial side-effects).

## 6. Web tools — `web_search` default ON (decided) + the contract conflict

**Decision: `web_search` included and default ON.**

⚠️ **This conflicts with the written contract.** `CLAUDE.md` states the
identity as "runs ENTIRELY on a local model with `MUSE_LOCAL_ONLY` ON BY
DEFAULT (cloud egress refused in code)", and the non-negotiables forbid
silent egress. Flipping `MUSE_LOCAL_ONLY`'s default to satisfy "web_search
ON" would rewrite the product's core promise and the
`user_local_first_security` memory. That should NOT be done silently.

**Reconciliation that honors the decision WITHOUT forfeiting the core
guarantee** (recommended — confirm before building slice 3):

Decouple two distinct egress classes that `MUSE_LOCAL_ONLY` currently
conflates:
1. **Private-data egress** — your notes/files/voice going to a *cloud
   LLM*. This is the actual privacy core. KEEP it local-only by default,
   refused in code. Untouched.
2. **Public-query egress** — a *search query string* going to a search
   API. This leaks far less (a query, not your corpus) and is what
   "web_search ON" wants.

So introduce a separate switch `MUSE_WEB_EGRESS` (default ON) that gates
ONLY `web_search`/`web_read`, independent of `MUSE_LOCAL_ONLY` (which
keeps governing LLM/voice/file-content egress, default ON). Net effect:
- web_search works out of the box (the decision), but
- your files still never reach a cloud LLM by default (the promise holds).
- `MUSE_LOCAL_ONLY=true` AND `MUSE_WEB_EGRESS=true` can coexist coherently;
  a strict user sets `MUSE_WEB_EGRESS=false` to kill all egress.
- `muse doctor` reports both posture lines distinctly.

If instead you truly want to flip `MUSE_LOCAL_ONLY` default to OFF, that's
a deliberate identity change requiring a `CLAUDE.md` + memory update in the
same change — flagged, not silent. The decoupled switch above avoids that.

`web_search`/`web_read` register iff their egress switch is ON; otherwise
they never enter the registry (model can't select them). The
`decideWebSearchPolicy` seam (already in `web-search-policy.ts`) is the
enforcement point.

## 7. Grounding integration (strengthens the core edge)

CLAUDE.md requires every change to STRENGTHEN the grounding/citation edge.
`file_read` / `file_grep` results carry `grounding: { source: <path>,
text: <matched content> }` (the `tool-result` stream event already has a
`grounding` field — verified in `agent-runtime-types.ts`). So reading a
local file becomes a **citeable source**: "answer from your files, quote
the source" gets stronger, not diluted. An un-groundable file claim is
dropped by the existing gate. This is the eval invariant to assert.

## 8. Package & wiring

New `@muse/fs` package (parallel to `@muse/macos`, `@muse/browser`),
behind an opt-in `MUSE_FS_TOOLS` env (same pattern as
`MUSE_MACOS_ACTUATORS`). Add to BOTH `package.json` deps and `tsconfig.json`
references (architecture.md build-graph rule). `createFsTools(options)`
returns the `MuseTool[]`; the CLI registers them into the `ToolRegistry`
when the flag is on. `run_command` already lives in `@muse/tools`; web
tools register conditionally per §6.

## 9. Eval plan (every tool ships its proof — agent-testing.md)

- **`eval:tools` golden cases** per tool: positive selection + arg-echo
  (`argMatches` on the prompt-literal path/pattern) + the confusable-set
  cases:
  - {`file_read`, `file_list`, `file_grep`} — "read todo.md" vs "find my
    md notes" vs "where did I mention X" must each pick the right one.
  - {`file_write`, `file_edit`} — "save this as X" vs "change line in X".
  - negative/IrrelAcc: a greeting / a pure musing ⇒ **zero** fs calls.
- **Terminal-state tests** (agent-core): file actually written/edited;
  deny path ⇒ store unchanged (no partial side-effect).
- **Path-sandbox unit battery** (§4).
- **Local-only test:** under default posture, `web_search`/`web_read`
  are absent from the registry; the must-refuse battery confirms no egress.
- **pass^k:** pre-verify each new live eval case STABLE 3/3 before landing
  (`MUSE_EVAL_REPEAT=3`).

## 10. Ship order (slices, safest first)

1. **`file_read` + `file_list` + `file_grep`** (read-only, no mutation
   risk, immediate grounding win) + path sandbox + eval cases.
2. **`file_write` + `file_edit` + `file_multi_edit`** (write) +
   approval-gate wiring + deny-path/deny-list terminal-state tests +
   the `file_edit`/`file_multi_edit` confusable-set eval.
3. **`web_search`** + `MUSE_WEB_EGRESS` switch (§6) + egress unit tests.
   (`web_read` joins the same switch; `run_command` already shipped —
   each gets an `eval:tools` case.)

Each slice is independently shippable and gated; slice 1 alone makes Muse
able to read & cite the local filesystem.

## 11. Decisions (RESOLVED 2026-06-16)

1. **`file_edit` split** — `file_edit` + `file_multi_edit`, 1:1 Claude
   Code parity; accept the confusable-set eval burden (§3).
2. **Sandbox = whole home `~` + deny-list** — broad access, deny-list is
   the security boundary (§4).
3. **`web_search` included, default ON** — reconciled via a separate
   `MUSE_WEB_EGRESS` switch so the core local-LLM privacy guarantee is
   NOT forfeited (§6). Confirm the switch approach before slice 3, OR
   decide to flip `MUSE_LOCAL_ONLY` default (needs CLAUDE.md + memory
   update in the same change).
4. **Package = new `@muse/fs`** (decided — parallel to `@muse/macos` /
   `@muse/browser`, opt-in via `MUSE_FS_TOOLS`).

## 12. Codex (OpenAI) as a reference

OpenAI's `codex` CLI is open source (license verified below). It is a
legitimate *reference* for tool ergonomics (how a production CLI shapes
its file/shell tools, sandboxing, approval UX), cloned to
`/Users/stark/dev/codex` as a sibling — NOT inside the Muse repo, so it
never enters Muse's git or build. Use it to *study patterns*, not to copy
code: Muse's architecture (local model, grounding gate, exposure policy)
differs enough that direct copying wouldn't fit, and license attribution
applies to any code actually derived from it.
