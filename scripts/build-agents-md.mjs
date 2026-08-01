#!/usr/bin/env node
// build-agents-md — give a non-Claude agent the same context Claude Code gets for free.
//
// Claude Code auto-loads CLAUDE.md and every file under .claude/rules/ on every session. Codex
// does not, so the text has to be projected. Four mechanisms were measured against codex 0.145.0:
//
//   project_doc_fallback_filenames  replaces AGENTS.md when it is ABSENT; it is not additive.
//   @import expansion               not supported — a probe file's token never appeared.
//   nested AGENTS.md                loads only when the work is inside that directory.
//   .agents/skills/                 name + description ALWAYS load; the body loads on demand.
//
// The first three forced everything into one 81 KB AGENTS.md that cost ~20k tokens a session and
// silently lost its tail below the default byte budget. The fourth splits the projection in two:
//
//   CORE_FILES   inlined in AGENTS.md. Always delivered, never a decision. Reserved for the
//                boundaries whose breach a revert cannot undo.
//   SKILL_SPECS  projected to .agents/skills/<name>/SKILL.md. The agent sees every name and
//                description at session start and pulls the body when the description matches.
//
// Skills are model-discretionary, so the split is a safety judgement, not a size one: a rule goes
// behind a skill only where a deterministic gate (githooks, lint, the approval gate) already
// catches the failure the rule describes. unprojectedSources keeps that judgement explicit — a
// new rule file assigned to neither layer fails the build instead of vanishing.
//
// The .claude/ files stay the single source of truth and this script projects them, so the two
// can never drift — `--check` is wired into the pre-push hook.
//
// Discovery paths verified on 0.145.0 from a SUBDIRECTORY of a probe repo, twice: a skill under
// $REPO_ROOT/.agents/skills is listed and one under .claude/skills is NOT.
//
// The hand-written workflow skills are COPIED here rather than symlinked, even though codex does
// follow a symlinked skill directory. Git stores a link as mode 120000, and a checkout with
// core.symlinks=false — the normal Windows configuration, which this repo supports — materialises
// it as a text file containing the target path. The skill then does not exist for codex and the
// pre-push gate blocks every documentation push. Everything under .agents/ is therefore a plain
// generated file, and `--check` is what keeps the copy honest.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const TARGET = path.join(ROOT, "AGENTS.md");
const SKILLS_DIR = ".agents/skills";
const BEGIN = "<!-- BEGIN GENERATED — `pnpm agents:build`. Edit the source files, never this block. -->";
const END = "<!-- END GENERATED -->";

/**
 * The truncation self-check the file tells a reader to run. It has to be the LAST line, and the
 * generated block no longer is one — it sits mid-file so the contract lands before the brief. A
 * hand-written sentinel would rot the moment someone appended a section below it, so the build
 * places it and `--check` treats a missing one as drift.
 */
export const SENTINEL = "<!-- END OF AGENTS.md — if this line is missing, your copy was truncated. -->";

export function ensureSentinel(text) {
  const withoutSentinel = text.split("\n").filter((line) => line !== SENTINEL).join("\n").trimEnd();
  return `${withoutSentinel}\n\n${SENTINEL}\n`;
}

/**
 * Codex silently truncates the project doc at this many bytes and prints nothing — the tail
 * simply never reaches the model. Measured with `codex debug prompt-input` on 0.145.0: at the
 * default, an AGENTS.md of 78 KB lost outbound-safety.md, tool-calling.md, testing.md and the
 * END marker, while the run looked entirely healthy.
 */
export const CODEX_DEFAULT_DOC_BUDGET = 32768;
const CODEX_CONFIG = path.join(process.env.HOME ?? "", ".codex", "config.toml");

/**
 * Inlined in AGENTS.md, in this order. The test for membership is not size or importance, it is
 * reversibility: if an agent never reading this text could do something no revert undoes, it
 * cannot be behind a skill the agent chooses whether to open.
 *
 * commits.md is deliberately NOT here even though it governs pushes — its irreversible half (no
 * force-push, no --no-verify, no tags, no alternate remote) is restated in the hand-written floor
 * section above the block, and the commit-msg and pre-push hooks reject the rest deterministically
 * whether or not the model read it. harness.md is not here either: it is a pointer to
 * contract.md, and once the target became a skill the pointer belongs beside it.
 */
export const CORE_FILES = [
  "CLAUDE.md",
  ".claude/rules/safety/outbound-safety.md",
];

/**
 * The on-demand layer. `description` is the only part an agent sees before deciding, so it names
 * the trigger and the nearest confusable skill — the same one-shot selection problem tool-calling.md
 * describes, applied to the rule set itself. It is hand-written because it is metadata about when
 * a rule applies, which the rule's own prose does not state.
 */
export const SKILL_SPECS = [
  {
    name: "muse-harness-contract",
    summary: "any non-trivial multi-step work — risk tiers, maker ≠ judge, the fail-closed gates",
    sources: [".claude/rules/engineering/harness.md", ".claude/harness/contract.md"],
    description:
      "Use before any non-trivial multi-step work in the Muse repo — it defines the risk tiers, the"
      + " mandatory builder/evaluator separation (maker is never judge), the fail-closed gates, and"
      + " what a handoff must carry. Skip only for a one-line answer or a single trivial edit.",
  },
  {
    name: "muse-testing",
    summary: "writing or running a test, or choosing which gate proves a change",
    sources: [".claude/rules/verification/testing.md"],
    description:
      "Use before writing, changing, or choosing how to run a test in the Muse repo — the gate ladder"
      + " (test:changed, per-package, smoke:broad, smoke:live, eval:*, lint), which runner applies,"
      + " where a test belongs, and the real-browser rule for UI changes. For grading the AGENT's"
      + " behaviour rather than the code, use muse-agent-evaluation instead.",
  },
  {
    name: "muse-agent-evaluation",
    summary: "grading the agent itself — tool selection, `pass^k`, judges, the scoreboard",
    sources: [
      ".claude/rules/verification/agent-testing.md",
      ".claude/rules/verification/self-eval.md",
    ],
    description:
      "Use when evaluating the AGENT rather than the code — tool selection, refusal, terminal-state"
      + " grading, pass^k reliability, LLM-judge design, eval battery authoring, and the self-eval"
      + " scoreboard including how to declare an intentional ratchet drop. For ordinary unit or"
      + " integration test placement, use muse-testing instead.",
  },
  {
    name: "muse-commit-and-push",
    summary: "committing, pushing, or creating and removing a worktree",
    sources: [".claude/rules/engineering/commits.md"],
    description:
      "Use before committing, pushing, branching, or removing a worktree in the Muse repo —"
      + " conventional-commit types, the required review-tier line and which diffs force an"
      + " independent evaluator, the standing push authorization and everything it excludes, the"
      + " rebase-before-push rule, and worktree lifecycle. Sending anything to a third party is not"
      + " covered here; AGENTS.md governs that directly.",
  },
  {
    name: "muse-architecture",
    summary: "adding a package, a provider adapter, a database call, or a project reference",
    sources: [".claude/rules/engineering/architecture.md"],
    description:
      "Use when adding or changing a package, a model provider adapter, the ModelProvider interface,"
      + " local-only enforcement, the MCP server allowlist, database access, or TypeScript project"
      + " references — it decides where code is allowed to live and which vendor SDK may appear"
      + " where. For lint and comment policy, use muse-code-style instead.",
  },
  {
    name: "muse-tool-design",
    summary: "adding or reshaping a tool the local model must select in one shot",
    sources: [".claude/rules/safety/tool-calling.md"],
    description:
      "Use when adding, renaming, or reshaping any MuseTool or MCP tool projection — a small local"
      + " model has to select the right tool in one inference, so this covers naming, required"
      + " parameter schemas with concrete examples, the use-when/not-when line, and the eval:tools"
      + " gate. Whether an action may reach a third party at all is not decided here.",
  },
  {
    name: "muse-code-style",
    summary: "writing source — the lint rules that are errors, and the comment policy",
    sources: [".claude/rules/engineering/code-style.md"],
    description:
      "Use when writing or reviewing Muse source for lint and comment policy — which ESLint rules"
      + " are errors, how to promote a new one, naming, and the enforced ban on round/iteration/goal"
      + " markers in comments. For where code should live, use muse-architecture instead.",
  },
  {
    name: "muse-codegraph",
    summary: "using optional CodeGraph v1.5 for indexed structural-code retrieval",
    sources: [".claude/rules/engineering/codegraph.md"],
    description:
      "Use before native file exploration for an indexed structural-code question in Muse — it"
      + " defines the CodeGraph v1.5 explore-first path, result-identity and negative-claim"
      + " guardrails, freshness recovery, and affected-test limits. Ignore it when CodeGraph is"
      + " unavailable or the current checkout has no usable index; literal text still uses grep.",
  },
  {
    name: "muse-cli-surface",
    summary: "adding or changing a `muse` CLI command",
    sources: [".claude/rules/engineering/cli-product.md"],
    description:
      "Use when adding or changing a `muse` CLI command, its storage paths, local versus remote"
      + " mode, or anything the CLI spawns as a process. Not for the web or desktop surfaces.",
  },
];

/** Every file inside one workflow skill's source directory, repo-relative. */
export function workflowSkillFiles(name) {
  const root = path.join(ROOT, ".claude", "skills", name);
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(absolute);
    return [path.relative(ROOT, absolute).split(path.sep).join("/")];
  });
  return existsSync(root) ? walk(root).sort() : [];
}

export function workflowSkills() {
  const dir = path.join(ROOT, ".claude", "skills");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(dir, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();
}

/**
 * The budget from a codex config, or null when the key is absent, scoped to TABLE-FREE lines only.
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
  return null;
}

/**
 * Project scope wins over user scope, which is how codex resolves it: in a TRUSTED repo it
 * reads `.codex/config.toml` walking from the project root down. That file is committed here,
 * so the budget ships with the repo instead of depending on each machine's home directory —
 * verified with a CODEX_HOME carrying no budget key at all.
 */
export function resolveDocBudget({ projectConfig, userConfig }) {
  return codexDocBudget(projectConfig) ?? codexDocBudget(userConfig) ?? CODEX_DEFAULT_DOC_BUDGET;
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
 * Every file Claude Code auto-loads must reach a non-Claude agent through one layer or the other.
 * Without this, adding a rule file would quietly deliver it to Claude Code alone: the old
 * single-block projection swept up anything under .claude/rules/, and splitting the projection
 * removed that property. Returning the list rather than throwing keeps it testable.
 */
export function unprojectedSources(files = sourceFiles()) {
  const projected = new Set([...CORE_FILES, ...SKILL_SPECS.flatMap((spec) => spec.sources)]);
  return files.filter((file) => !projected.has(file));
}

/**
 * The other half of "exactly one layer". A rule inlined AND behind a skill is delivered twice,
 * spending the byte budget the split exists to protect and leaving two copies to disagree about
 * which one an agent read. Zero-assignment was the obvious failure; this is the quiet one.
 */
export function duplicatedSources(
  projected = [...CORE_FILES, ...SKILL_SPECS.flatMap((spec) => spec.sources)],
) {
  const counts = new Map();
  for (const file of projected) counts.set(file, (counts.get(file) ?? 0) + 1);
  return [...counts].filter(([, count]) => count > 1).map(([file]) => file).sort();
}

/**
 * A link written inside .claude/rules/verification/ resolves against THAT directory. Once the
 * text is inlined at the repo root the same link points somewhere else, so every relative
 * target is re-expressed from the root. Absolute paths, URLs and bare fragments are untouched:
 * a bare `#fragment` still resolves because the heading it names is inlined too.
 */
export function rewriteLinks(body, fromDir, toDir = "") {
  const reExpress = (target) => path.relative(path.join(ROOT, toDir), target) || ".";
  const withLinks = body.replace(/\]\(([^)\s]+)\)/gu, (whole, target) => {
    if (/^(https?:|mailto:|#|\/)/u.test(target)) return whole;
    const [rawPath, fragment] = target.split("#");
    if (!rawPath) return whole;
    const resolved = reExpress(path.resolve(ROOT, fromDir, rawPath));
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
    return `\`${reExpress(target)}\``;
  });
}

/**
 * A source's own YAML frontmatter is metadata for where it lives, not part of its text. Inlined
 * it becomes a stray `---` block mid-document; in a SKILL.md it lands under the generated
 * frontmatter and its `related:` paths resolve against the wrong directory — which is how
 * contract.md's siblings turned into three broken references the moment it became a skill.
 */
export function stripFrontmatter(body) {
  const match = /^---\n[\s\S]*?\n---\n/u.exec(body);
  return match ? body.slice(match[0].length).trimStart() : body;
}

function projectSource(file, toDir = "") {
  const body = stripFrontmatter(readFileSync(path.join(ROOT, file), "utf8").trimEnd());
  return rewriteLinks(body, path.dirname(file), toDir);
}

export function renderBlock() {
  const parts = [
    BEGIN,
    "",
    "# The contract — reproduced because you are not Claude Code",
    "",
    "The files below are reproduced verbatim, which means they still address the reader they were",
    "written for. **Where an inlined file says `.claude/rules/` is auto-loaded, or cites a rule by",
    "its `.claude/rules/...` path, read that as the matching skill below** — for you those rules",
    "are on-demand, not automatic, and the path is where the skill's text comes from rather than",
    "somewhere you must go.",
    "",
    "Everything down to the closing marker is generated by `scripts/build-agents-md.mjs` — edit the",
    "source file, then run `pnpm agents:build`. The pre-push hook fails if it is stale.",
    "",
    "## The rest of the rules — skills in `.agents/skills/`",
    "",
    "Each is a rule file, verbatim, behind a description that says when it applies. An agent that",
    "resolves the open agent-skills standard is given every name and description at session start",
    "and loads the body when one matches; any other agent opens the path directly. They are not",
    "optional reading material — they are the same contract, indexed by task.",
    "",
    "| Skill | Read it before |",
    "| --- | --- |",
    ...SKILL_SPECS.map(
      (spec) => `| [\`${spec.name}\`](${SKILLS_DIR}/${spec.name}/SKILL.md) | ${spec.summary} |`,
    ),
    "",
    "The same directory carries this repo's hand-written workflow skills too, projected from",
    "`.claude/skills/` by the same build:",
    "",
    "`" + workflowSkills().join("`, `") + "`.",
    "",
    "## Inlined here, in full",
    "",
    ...CORE_FILES.map((file) => `- [\`${file}\`](${file})`),
    "",
  ];
  for (const file of CORE_FILES) {
    parts.push("---", "", `<!-- source: ${file} -->`, "", projectSource(file), "");
  }
  // compose() finds the terminator by scanning forward for END, so an END anywhere inside the
  // body would cut the block short and leave the remainder orphaned in the file — which is
  // exactly what a draft of this intro did. Fail rather than emit a self-corrupting block.
  const body = parts.join("\n");
  if (body.includes(END)) {
    throw new Error(`A projected source contains the closing marker ${END}; it would truncate the block.`);
  }
  return `${body}\n${END}`;
}

/**
 * A skill body is the rule verbatim under generated frontmatter, with every path re-expressed
 * against the skill's own directory. Leaving them repo-root-relative reads better but is wrong
 * the way a markdown link is wrong: nothing resolves it from the root, including this repo's
 * own check-doc-links gate.
 */
export function renderSkill(spec) {
  const dir = `${SKILLS_DIR}/${spec.name}`;
  const parts = [
    "---",
    `name: ${spec.name}`,
    `description: ${spec.description}`,
    "---",
    "",
    `<!-- Generated by scripts/build-agents-md.mjs from ${spec.sources.join(", ")}.`,
    "     Edit the source file, then run `pnpm agents:build`. -->",
    "",
  ];
  for (const file of spec.sources) {
    parts.push(`<!-- source: ${file} -->`, "", projectSource(file, dir), "");
  }
  return `${parts.join("\n").trimEnd()}\n`;
}

/**
 * The whole generated `.agents` tree as path → entry, so `--check` compares what is on disk
 * against every expectation at once, including entries that should no longer exist.
 */
/**
 * A workflow skill copied out of .claude/skills, with its relative paths re-aimed at the copy's
 * own location. Copying verbatim broke eleven references: `../../../harness/contract.md` resolves
 * inside `.claude/` and points at nothing from `.agents/`. Non-markdown travels untouched.
 */
function projectWorkflowFile(source, toDir) {
  const body = readFileSync(path.join(ROOT, source), "utf8");
  if (!source.endsWith(".md")) return body;
  const fromDir = path.posix.dirname(source);
  return rewriteRelated(rewriteLinks(body, fromDir, toDir), fromDir, toDir);
}

/**
 * Frontmatter `related:` entries are paths but not links, so the markdown pass never sees them —
 * and check-doc-links resolves them, which is how the gap surfaced.
 */
export function rewriteRelated(body, fromDir, toDir) {
  const match = /^---\n([\s\S]*?\n)---\n/u.exec(body);
  if (!match) return body;
  const rewritten = match[1].replace(/(^|[\s[,])(\.{1,2}\/[^\s,\]]+\.md)/gu, (whole, lead, target) =>
    `${lead}${path.relative(path.join(ROOT, toDir), path.resolve(ROOT, fromDir, target))}`);
  return `---\n${rewritten}---\n${body.slice(match[0].length)}`;
}

export function skillTree() {
  const tree = new Map();
  for (const spec of SKILL_SPECS) {
    tree.set(`${SKILLS_DIR}/${spec.name}/SKILL.md`, { file: renderSkill(spec) });
  }
  for (const name of workflowSkills()) {
    for (const source of workflowSkillFiles(name)) {
      const relative = `${SKILLS_DIR}/${source.slice(".claude/skills/".length)}`;
      tree.set(relative, { file: projectWorkflowFile(source, path.posix.dirname(relative)) });
    }
  }
  return tree;
}

/**
 * Anything under .agents/skills the projection does not own — a renamed skill's old directory,
 * or a file left inside a generated one. Both keep being offered to the model, and a comparison
 * that only walks the paths it EXPECTS cannot see either.
 */
export function staleSkillEntries() {
  const root = path.join(ROOT, SKILLS_DIR);
  if (!existsSync(root)) return [];
  const owned = new Set([...skillTree().keys()].map((key) => key.slice(`${SKILLS_DIR}/`.length)));
  const stale = [];
  const walk = (relative) => {
    const absolute = path.join(root, relative);
    // A directory replaced by a symlink would be DESCENDED, and then written through and deleted
    // through, reaching whatever it points at outside .agents. It is not a directory this
    // projection owns, so it is stale rather than somewhere to walk.
    if (isLink(absolute)) {
      stale.push(relative);
      return;
    }
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const child = relative ? path.posix.join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) walk(child);
      else if (!owned.has(child)) stale.push(child);
    }
  };
  walk("");
  return stale.sort();
}

function isLink(absolute) {
  try {
    return lstatSync(absolute).isSymbolicLink();
  } catch {
    return false;
  }
}

function readEntry(absolute) {
  if (isLink(absolute)) return { link: readlinkSync(absolute) };
  if (!existsSync(absolute)) return null;
  return { file: readFileSync(absolute, "utf8") };
}

export function skillTreeDrift() {
  const drift = [];
  for (const [relative, expected] of skillTree()) {
    const actual = readEntry(path.join(ROOT, relative));
    if (!actual) drift.push(`${relative} is missing`);
    else if (actual.link !== undefined) drift.push(`${relative} is a symlink, not a generated file`);
    else if (actual.file !== expected.file) drift.push(`${relative} is out of date`);
  }
  for (const name of staleSkillEntries()) drift.push(`${SKILLS_DIR}/${name} is no longer projected`);
  return drift;
}

/**
 * A projected file that git does not track is not published: a commit that adds AGENTS.md and
 * forgets `.agents` leaves every fresh checkout with no skills at all, and a content-only
 * comparison against the working tree calls that current. The workflow skills' SOURCE tree is
 * required too — a copy whose original was never committed is a projection of nothing.
 */
export function untrackedProjection() {
  const listed = execFileSync("git", ["ls-files", "--", SKILLS_DIR, ".claude/skills"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const tracked = new Set(listed.split("\n").filter(Boolean));
  const required = [...skillTree().keys(), ...workflowSkills().flatMap(workflowSkillFiles)];
  return [...new Set(required)].filter((relative) => !tracked.has(relative)).sort();
}

/**
 * Everything the published projection depends on. Enumerated rather than assumed, because each
 * omission has been a real hole: leaving the generator out let a prose change to it ship beside
 * outputs generated by a version nobody committed, and the nested `AGENTS.md` files feed the
 * byte budget the same way a rule feeds a skill.
 */
const PROJECTION_PATHS = [
  "CLAUDE.md",
  ".claude",
  "AGENTS.md",
  SKILLS_DIR,
  "scripts/build-agents-md.mjs",
  "*/AGENTS.md",
];

/**
 * `--check` verifies the WORKING TREE, but pre-push publishes the commit. Everything this script
 * proves is proven about files on disk, and that transfers to HEAD only when HEAD holds the same
 * bytes — so any difference between HEAD and the working tree, in a source OR an output, means
 * the published snapshot is not the one that was checked.
 *
 * An earlier version excused a differing source, on the theory that mid-edit rule changes are
 * normal and should not block an unrelated push. That opened the mirror hole: commit the
 * regenerated SKILL.md, leave the rule uncommitted, and HEAD carries a projection of text it
 * does not contain. A gate that cannot conclude must fail, so this reports rather than excuses.
 */
export function uncommittedProjection() {
  try {
    return execFileSync("git", ["diff", "HEAD", "--name-only", "--", ...PROJECTION_PATHS], {
      cwd: ROOT,
      encoding: "utf8",
      // A repo with no commits yet makes git complain to stderr before the catch below runs.
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .filter(Boolean)
      .sort();
  } catch {
    // No HEAD yet (a fresh repo): there is no published snapshot to disagree with.
    return [];
  }
}

/**
 * Whether the projection will actually be PUBLISHED, which is a different question from whether
 * it matches the sources. Kept out of skillTreeDrift so "the tree matches the generator" stays a
 * statement about content — a correct projection you have not committed yet is not content drift.
 */
export function publicationDrift() {
  return [
    ...untrackedProjection().map((relative) => `${relative} is not tracked by git`),
    ...uncommittedProjection().map((relative) => `${relative} differs between HEAD and the working tree`),
  ];
}

function writeSkillTree() {
  for (const name of staleSkillEntries()) {
    rmSync(path.join(ROOT, SKILLS_DIR, name), { recursive: true, force: true });
  }
  for (const [relative, entry] of skillTree()) {
    const absolute = path.join(ROOT, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    // writeFileSync follows a symlink, so a planted one would receive the generated body.
    if (isLink(absolute)) rmSync(absolute, { force: true });
    writeFileSync(absolute, entry.file);
  }
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
    + `  Fix: set project_doc_max_bytes = ${Math.ceil((bytes * 1.5) / 10000) * 10000} in .codex/config.toml\n`
    + `  (which this repo ships; it applies only once the repo is TRUSTED), or in ${CODEX_CONFIG}.`;
}

/**
 * The split exists so the inlined contract survives on a machine that never configured codex —
 * an untrusted repo, a fresh checkout, a CI box. Raising the configured budget hides that, so
 * this threshold is the fixed default and is checked whatever the config says. Fixing it means
 * moving a rule into SKILL_SPECS, not raising a number.
 *
 * Unlike checkBudget this one FAILS the command rather than warning. It can: it reads only
 * committed repo content, so it cannot be tripped by someone's home directory, and pre-push runs
 * `--check` and nothing else — a warning there is a warning nobody is required to see.
 */
export function checkDefaultBudget(bytes, nested = nestedDocs()) {
  const { chain, worst } = heaviestChain(nested);
  const total = bytes + worst;
  if (total <= CODEX_DEFAULT_DOC_BUDGET) return null;
  const composed = worst > 0 ? ` composed with ${chain.join(" + ")}` : "";
  return `AGENTS.md is ${bytes} bytes,${composed} = ${total}, over the `
    + `${CODEX_DEFAULT_DOC_BUDGET}-byte budget codex\n`
    + `  uses when nothing raised it — an untrusted repo or an unconfigured machine loses the\n`
    + `  tail silently. Codex concatenates every instruction file from the root down to the\n`
    + `  directory being worked in, so the root file alone fitting is not enough.\n`
    + `  Fix: move a rule from CORE_FILES to SKILL_SPECS in scripts/build-agents-md.mjs.`;
}

/**
 * The heaviest root→cwd chain, since codex concatenates EVERY instruction file along that path
 * and not merely the nearest. Taking the single largest file was wrong the moment a nested doc
 * sat under another one: `packages/model/` plus `packages/model/deep/` compose, and the gate
 * scored only the larger of the two while codex loaded both.
 */
export function heaviestChain(nested) {
  let worst = 0;
  let chain = [];
  for (const leaf of nested) {
    const dir = path.posix.dirname(leaf.file);
    const ancestors = nested.filter((doc) => {
      const other = path.posix.dirname(doc.file);
      return dir === other || dir.startsWith(`${other}/`);
    });
    const bytes = ancestors.reduce((sum, doc) => sum + doc.bytes, 0);
    if (bytes > worst) {
      worst = bytes;
      chain = ancestors.map((doc) => `${doc.file} (${doc.bytes})`);
    }
  }
  return { chain, worst };
}

/**
 * The nested `AGENTS.md` files, which codex composes onto the root one for the directory being
 * worked in. Sizes only — which of them compose together is `heaviestChain`'s job.
 */
export function nestedDocs() {
  const listed = execFileSync("git", ["ls-files", "--", "*/AGENTS.md"], { cwd: ROOT, encoding: "utf8" });
  return listed
    .split("\n")
    .filter(Boolean)
    .map((file) => ({ file, bytes: Buffer.byteLength(readFileSync(path.join(ROOT, file), "utf8")) }));
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (invokedDirectly) {
  const orphans = unprojectedSources();
  if (orphans.length > 0) {
    process.stderr.write(
      `\n✗ Claude Code auto-loads these, and nothing projects them to other agents:\n`
        + orphans.map((file) => `    ${file}\n`).join("")
        + `  Fix: add each to CORE_FILES (always inlined) or to a SKILL_SPECS entry\n`
        + `  (loaded on demand) in scripts/build-agents-md.mjs.\n\n`,
    );
    process.exit(1);
  }
  const duplicates = duplicatedSources();
  if (duplicates.length > 0) {
    process.stderr.write(
      `\n✗ These are projected through more than one layer, so an agent receives two copies:\n`
        + duplicates.map((file) => `    ${file}\n`).join("")
        + `  Fix: keep each in CORE_FILES or in exactly one SKILL_SPECS entry.\n\n`,
    );
    process.exit(1);
  }

  const current = readFileSync(TARGET, "utf8");
  const next = ensureSentinel(compose(current, renderBlock()));
  const bytes = Buffer.byteLength(next);
  const read = (file) => (existsSync(file) ? readFileSync(file, "utf8") : "");
  const budgetProblem = checkBudget(bytes, {
    budget: resolveDocBudget({
      projectConfig: read(path.join(ROOT, ".codex", "config.toml")),
      userConfig: read(CODEX_CONFIG),
    }),
    codexInstalled: existsSync(path.dirname(CODEX_CONFIG)),
  });
  // A WARNING, never an exit code. The budget lives in a per-user file outside the repo, so
  // failing here would refuse to regenerate AGENTS.md and block every doc-touching push on any
  // machine with an unedited codex config — a repo bricked by someone's home directory. The
  // actual protection against truncation is the self-check the appendix tells a reader to run.
  if (budgetProblem) process.stderr.write(`\n! ${budgetProblem}\n\n`);

  const summary = `${CORE_FILES.length} inlined, ${SKILL_SPECS.length} projected as skills, `
    + `${workflowSkills().length} copied`;
  if (process.argv.includes("--check")) {
    const drift = [
      next === current ? null : "AGENTS.md is out of date",
      ...skillTreeDrift(),
      ...publicationDrift(),
    ].filter(Boolean);
    if (drift.length > 0) {
      process.stderr.write(
        "\n✗ The agent projection is stale:\n"
          + drift.map((line) => `    ${line}\n`).join("")
          + "  A non-Claude agent would be working from older instructions than Claude Code.\n"
          + "  Fix: pnpm agents:build, then commit AGENTS.md and .agents alongside the rule\n"
          + "  they were generated from — what is pushed is what other agents will read.\n\n",
      );
      process.exit(1);
    }
    process.stdout.write(`[agents:build] projection is current (${summary}).\n`);
  } else {
    writeFileSync(TARGET, next);
    writeSkillTree();
    process.stdout.write(`[agents:build] projected ${summary}.\n`);
  }
  // Last, so the file is written and `--check` has reported drift first — an over-budget
  // projection is a real failure, not advice, and pre-push runs `--check` and nothing else.
  const defaultProblem = checkDefaultBudget(bytes);
  if (defaultProblem) {
    process.stderr.write(`\n✗ ${defaultProblem}\n\n`);
    process.exit(1);
  }
}
