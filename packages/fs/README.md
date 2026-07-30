# @muse/fs

Owns Muse's native local filesystem tools: in-process `MuseTool`s that read, search, and write
files on the user's machine, the way Claude Code's Read/Glob/Grep/Write/Edit do. It is a package
rather than a folder because every one of these tools must route through the same deterministic
path sandbox before touching disk — that invariant only holds if it lives in one shared module.

## Public surface

All exports are re-exported flat (`export *`) from these modules:

- `fs-path-safety` — the deterministic path sandbox: a broad allow-root (home dir by default)
  governed by a fail-closed deny-list for credential/key/secret material. Every tool routes
  through it.
- `fs-read-tools` — read/search `MuseTool`s (read file, glob, grep-equivalent).
- `fs-write-tools` — write/edit `MuseTool`s.
- `edit-integrity` — pre/post-write integrity checks for an edit operation.
- `fs-checkpoints` — checkpoint/restore support for a file-write sequence.
- `fs-document` — document-format extraction (PDF/DOCX/ZIP via `pdfjs-dist`/`mammoth`/`jszip`).
- `fs-gitignore` — `.gitignore`-aware path filtering (via `ignore`).

## Depends on

- `@muse/policy` — permission/budget policy consulted by the write-tier tools.
- `@muse/shared` — common primitives.
- `@muse/tools` — the `MuseTool` contract these filesystem tools implement.

## Rules that bind this package

Every path a tool touches must resolve through `fs-path-safety`'s sandbox before any read or
write — that is the deterministic, fail-close boundary this package exists to guarantee, per
[`../../CLAUDE.md`](../../CLAUDE.md)'s "guards are fail-close" rule. Tools are opt-in at the CLI
boundary (`MUSE_FS_TOOLS`); the approval gate for write-tier tools is injected there, not built
into this package.

## Tests

```bash
pnpm --filter @muse/fs test
```
