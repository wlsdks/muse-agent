# 234 — `muse search --to-notes` scrub: control-byte + markdown-splice parity

## Why

`muse search --to-notes` persists external web-search results
into a markdown note that (a) the user reads in a terminal /
editor, (b) "may sync to a third party" (the code's own
comment), and (c) is later **indexed into RAG** — making a
poisoned web result the canonical *indirect prompt-injection*
chain. Web-result `title` / `snippet` are fully
attacker-controllable (anyone can rank a page with a crafted
title).

Two real gaps in the persist path (lines 149/151):

1. **`title` had no whitespace collapse.** It was
   `redactSecretsInText((r.title ?? "").trim() || "(untitled)")`
   — a multi-line title (`Foo\n\n## Injected heading\n…`)
   spliced a **fake markdown heading** into the saved note
   (markdown-structure injection; re-rendered / re-fed as a
   real `##`). The `snippet` *was* `\s+`-collapsed — an
   asymmetric, inconsistent guard.
2. **Neither `title` nor `snippet` stripped control bytes.**
   ESC / C0 / C1 / DEL (parallel to the 227–231 sweep) from a
   poisoned result survived into the note → ANSI execution
   when the user reads it, and survives into the RAG re-feed.

Inconsistency made it concrete: the **console-display** path
(lines 180-181) already did `stripUntrustedTerminalChars(...)`
on title/url — the higher-stakes **persist-to-notes** path
did not.

## Scope

- `apps/cli/src/commands-search.ts`: add an exported
  `scrubResultText(raw)` =
  `redactSecretsInText(stripUntrustedTerminalChars(raw).replace(/\s+/gu," ").trim())`
  (both helpers already imported) — control-strip → whitespace
  collapse → trim → redact. Apply it to both `title`
  (`scrubResultText(r.title ?? "") || "(untitled)"`) and
  `snippet`. URL stays verbatim (mangling breaks the
  clickable link — unchanged). One coherent change; the
  display-path scrub is the established reference.
- New `scrubResultText` cases in
  `apps/cli/src/commands-search.test.ts`: whitespace/newline
  collapse (no fake `##` splice), ESC/C0/C1/DEL stripped, a
  credential shape redacted (split-prefix literal, no
  push-protection trip), and control-only / blank → empty (so
  the title fallback `|| "(untitled)"` engages).

## Verify

- `pnpm --filter @muse/cli test` — 550 pass (4 new
  `scrubResultText` cases; existing parseLimit + suite
  unchanged → no regression).
- `pnpm check` exit 0; `pnpm lint` exit 0.
- Pure deterministic string scrub — no model invoked; the
  composed behaviour (control-strip + whitespace-collapse +
  redact) is exhaustively unit-tested (authoritative per the
  testing rules, consistent with the 195 redaction and
  227–231 control-byte goals). No smoke:live needed; no raw
  bytes in source (`String.fromCharCode`).

## Status

done — an attacker-controlled web-search title/snippet can no
longer splice a fake markdown heading or carry ANSI / C0 / C1
/ DEL bytes into a saved note (and thus into the RAG re-feed
or a third-party sync). The persist-to-notes scrub now has
parity with the console-display path.
