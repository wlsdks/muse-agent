#!/usr/bin/env node
// build-agents-md — give a non-Claude agent the same context Claude Code gets for free.
//
// Claude Code auto-loads CLAUDE.md and every file under .claude/rules/ on every session.
// Codex loads AGENTS.md (root + nested, composed) and nothing else. Three mechanisms were
// tested directly against codex 0.145.0 and none closes the gap:
//
//   project_doc_fallback_filenames  replaces AGENTS.md when it is ABSENT; it is not additive.
//   @import expansion               not supported — a probe file's token never appeared.
//   nested AGENTS.md                loads only when the work is inside that directory.
//
// So the text has to physically live in AGENTS.md. Routing ("go read .claude/rules/...")
// was the previous answer and it depends on the agent choosing to comply; this does not.
// The split files stay the single source of truth and this script projects them, so the
// two can never drift — `--check` is wired into the pre-push hook.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const TARGET = path.join(ROOT, "AGENTS.md");
const BEGIN = "<!-- BEGIN GENERATED — `pnpm agents:build`. Edit the source files, never this block. -->";
const END = "<!-- END GENERATED -->";

/**
 * Codex silently truncates the project doc at this many bytes and prints nothing — the tail
 * simply never reaches the model. Measured with `codex debug prompt-input` on 0.145.0: at the
 * default, an AGENTS.md of 78 KB lost outbound-safety.md, tool-calling.md, testing.md and the
 * END marker, while the run looked entirely healthy.
 */
export const CODEX_DEFAULT_DOC_BUDGET = 32768;
const CODEX_CONFIG = path.join(process.env.HOME ?? "", ".codex", "config.toml");

/**
 * The effective budget from a codex config, or the default when the key is absent, scoped to
 * TABLE-FREE lines only.
 *
 * Everything after the first `[table]` header belongs to that table, so a
 * `project_doc_max_bytes` appended to the end of the file sits inside the last
 * `[projects."…"]` entry and codex ignores it. A line-anchored scan read it as the real budget
 * and reported everything fine while codex truncated — the gate blessing the exact
 * misconfiguration it exists to catch. Anything not a plain integer (`0x30000`, `2e5`) falls
 * back to the default, so an unparseable value warns rather than passes.
 */
export function codexDocBudget(configText) {
  for (const line of String(configText ?? "").split("\n")) {
    if (/^\s*\[/u.test(line)) break;
    const match = /^\s*project_doc_max_bytes\s*=\s*(\S+)/u.exec(line);
    if (!match) continue;
    const value = match[1].replace(/_/gu, "");
    return /^\d+$/u.test(value) ? Number(value) : CODEX_DEFAULT_DOC_BUDGET;
  }
  return CODEX_DEFAULT_DOC_BUDGET;
}

/**
 * The exact set Claude Code auto-loads. Sorted so the projection is deterministic.
 *
 * Listed by directory, not by a `**` pathspec: git's default pathspec requires `**` to match a
 * literal slash, so `.claude/rules/**\/*.md` silently skipped any rule placed directly in
 * `.claude/rules/` — and `--check` still called the projection current.
 */
export function sourceFiles() {
  // --others so a brand-new rule file counts before it is staged: Claude Code loads it from
  // disk the moment it exists, and the projection has to keep up with that, not with the index.
  const listed = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "--", ".claude/rules"],
    { cwd: ROOT, encoding: "utf8" },
  );
  const rules = [...new Set(listed.split("\n").filter((file) => file.endsWith(".md")))].sort();
  return ["CLAUDE.md", ...rules];
}

/**
 * A link written inside .claude/rules/verification/ resolves against THAT directory. Once the
 * text is inlined at the repo root the same link points somewhere else, so every relative
 * target is re-expressed from the root. Absolute paths, URLs and bare fragments are untouched:
 * a bare `#fragment` still resolves because the heading it names is inlined too.
 */
export function rewriteLinks(body, fromDir) {
  const withLinks = body.replace(/\]\(([^)\s]+)\)/gu, (whole, target) => {
    if (/^(https?:|mailto:|#|\/)/u.test(target)) return whole;
    const [rawPath, fragment] = target.split("#");
    if (!rawPath) return whole;
    const resolved = path.relative(ROOT, path.resolve(ROOT, fromDir, rawPath));
    return `](${resolved}${fragment ? `#${fragment}` : ""})`;
  });
  // A backticked bare path — the common label form, `` [`../engineering/commits.md`](…) `` — is
  // a citation, not a link, so the pass above misses it and it silently keeps pointing at the
  // source directory. Rewrite only spans that start ./ or ../ AND resolve to a real file, so a
  // shell snippet containing `../` is never mangled.
  return withLinks.replace(/`([^`\n]+)`/gu, (whole, inner) => {
    if (!/^\.\.?\//u.test(inner)) return whole;
    const target = path.resolve(ROOT, fromDir, inner);
    if (!existsSync(target)) return whole;
    return `\`${path.relative(ROOT, target)}\``;
  });
}

export function renderBlock() {
  const files = sourceFiles();
  const parts = [
    BEGIN,
    "",
    "# Appendix — the context Claude Code is given automatically",
    "",
    "Claude Code auto-loads the files below on every session. You do not, so they are reproduced",
    "here verbatim and they bind you the same way — provided you received all of them; see the",
    "truncation warning near the top of this file. This block is generated by",
    "`scripts/build-agents-md.mjs` from the paths listed; the pre-push hook fails if it is stale.",
    "Edit the source file, then run `pnpm agents:build`.",
    "",
    ...files.map((file) => `- [\`${file}\`](${file})`),
    "",
  ];
  for (const file of files) {
    const body = rewriteLinks(readFileSync(path.join(ROOT, file), "utf8").trimEnd(), path.dirname(file));
    parts.push("---", "", `<!-- source: ${file} -->`, "", body, "");
  }
  parts.push(END);
  return parts.join("\n");
}

export function compose(current, block) {
  const start = current.indexOf(BEGIN);
  if (start === -1) return `${current.trimEnd()}\n\n${block}\n`;
  const end = current.indexOf(END, start);
  if (end === -1) throw new Error("AGENTS.md has a BEGIN marker with no END marker.");
  return `${current.slice(0, start)}${block}${current.slice(end + END.length)}`;
}

/**
 * The projection is worthless if codex drops half of it, so size is a gate rather than a
 * comment. Only enforced where codex is actually installed: on a Claude-only machine the
 * budget is not a real constraint and blocking a push on it would be noise.
 */
export function checkBudget(bytes, { budget, codexInstalled }) {
  if (!codexInstalled || bytes <= budget) return null;
  return `AGENTS.md is ${bytes} bytes but codex reads at most ${budget}.\n`
    + `  The tail is dropped SILENTLY — the rules at the end never reach the model.\n`
    + `  Fix: raise it in ${CODEX_CONFIG}\n`
    + `    project_doc_max_bytes = ${Math.ceil((bytes * 1.5) / 10000) * 10000}`;
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (invokedDirectly) {
  const current = readFileSync(TARGET, "utf8");
  const next = compose(current, renderBlock());
  const budgetProblem = checkBudget(Buffer.byteLength(next), {
    budget: codexDocBudget(existsSync(CODEX_CONFIG) ? readFileSync(CODEX_CONFIG, "utf8") : ""),
    codexInstalled: existsSync(path.dirname(CODEX_CONFIG)),
  });
  // A WARNING, never an exit code. The budget lives in a per-user file outside the repo, so
  // failing here would refuse to regenerate AGENTS.md and block every doc-touching push on any
  // machine with an unedited codex config — a repo bricked by someone's home directory. The
  // actual protection against truncation is the self-check the appendix tells a reader to run.
  if (budgetProblem) process.stderr.write(`\n! ${budgetProblem}\n\n`);
  if (process.argv.includes("--check")) {
    if (next !== current) {
      process.stderr.write(
        "\n✗ AGENTS.md is stale: it no longer matches CLAUDE.md + .claude/rules/.\n"
          + "  A non-Claude agent would be working from older instructions than Claude Code.\n"
          + "  Fix: pnpm agents:build && git add AGENTS.md\n\n",
      );
      process.exit(1);
    }
    process.stdout.write(`[agents:build] AGENTS.md is current (${sourceFiles().length} source files).\n`);
  } else {
    writeFileSync(TARGET, next);
    process.stdout.write(`[agents:build] projected ${sourceFiles().length} source files into AGENTS.md.\n`);
  }
}
