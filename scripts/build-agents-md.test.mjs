import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CODEX_DEFAULT_DOC_BUDGET,
  CORE_FILES,
  SENTINEL,
  SKILL_SPECS,
  checkBudget,
  checkDefaultBudget,
  codexDocBudget,
  compose,
  duplicatedSources,
  ensureSentinel,
  rewriteRelated,
  workflowSkills,
  workflowSkillFiles,
  renderBlock,
  renderSkill,
  resolveDocBudget,
  rewriteLinks,
  skillTree,
  skillTreeDrift,
  nestedDocs,
  publicationDrift,
  sourceFiles,
  stripFrontmatter,
  staleSkillEntries,
  unprojectedSources,
} from "./build-agents-md.mjs";

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

// Codex drops the tail of an over-budget project doc and says nothing. An 78 KB AGENTS.md lost
// outbound-safety.md, tool-calling.md and testing.md while every run still looked healthy.
test("an over-budget projection is reported, with the remedy", () => {
  const problem = checkBudget(78788, { budget: CODEX_DEFAULT_DOC_BUDGET, codexInstalled: true });
  assert.match(problem, /78788 bytes but codex reads at most 32768/u);
  assert.match(problem, /SILENTLY/u);
  assert.match(problem, /project_doc_max_bytes = \d+/u);
});

test("a projection that fits, or a machine without codex, reports nothing", () => {
  assert.equal(checkBudget(10, { budget: CODEX_DEFAULT_DOC_BUDGET, codexInstalled: true }), null);
  assert.equal(checkBudget(78788, { budget: CODEX_DEFAULT_DOC_BUDGET, codexInstalled: false }), null);
  assert.equal(checkBudget(78788, { budget: 200000, codexInstalled: true }), null);
});

test("the budget is read from the codex config, defaulting when absent", () => {
  assert.equal(codexDocBudget("model = \"x\"\nproject_doc_max_bytes = 200000\n"), 200000);
  assert.equal(codexDocBudget("model = \"x\"\n"), null, "absent is null, not a guess");
  assert.equal(codexDocBudget(undefined), null);
});

test("a commented-out or table-scoped budget key does not count", () => {
  assert.equal(codexDocBudget("# project_doc_max_bytes = 200000\n"), null);
  // The real trap: appending the key to a config that ends in tables puts it inside the last
  // one, where codex ignores it. Reading it as the budget blesses a truncating config.
  assert.equal(
    codexDocBudget('[projects."/x"]\ntrust_level = "trusted"\nproject_doc_max_bytes = 200000\n'),
    null,
  );
});

test("a budget value that is not a plain integer falls back rather than passing", () => {
  assert.equal(codexDocBudget("project_doc_max_bytes = 200_000\n"), 200000);
  for (const value of ["0x30000", "2e5", '"200000"', "true"]) {
    assert.equal(codexDocBudget(`project_doc_max_bytes = ${value}\n`), CODEX_DEFAULT_DOC_BUDGET, value);
  }
});

// The repo ships .codex/config.toml, so the budget travels with the checkout instead of
// depending on each machine's home directory. Project scope wins, exactly as codex resolves it.
test("the project config outranks the user config, and absent falls through", () => {
  assert.equal(resolveDocBudget({
    projectConfig: "project_doc_max_bytes = 200000\n",
    userConfig: "project_doc_max_bytes = 40000\n",
  }), 200000);
  assert.equal(resolveDocBudget({ projectConfig: "", userConfig: "project_doc_max_bytes = 40000\n" }), 40000);
  assert.equal(resolveDocBudget({ projectConfig: "", userConfig: "" }), CODEX_DEFAULT_DOC_BUDGET);
  // An unusable project value stops there rather than inheriting a permissive user value.
  assert.equal(resolveDocBudget({
    projectConfig: "project_doc_max_bytes = 2e5\n",
    userConfig: "project_doc_max_bytes = 200000\n",
  }), CODEX_DEFAULT_DOC_BUDGET);
});

test("a projection exactly at the budget is allowed, one byte over is not", () => {
  assert.equal(checkBudget(32768, { budget: 32768, codexInstalled: true }), null);
  assert.match(checkBudget(32769, { budget: 32768, codexInstalled: true }), /32769 bytes/u);
});

// The split exists so the inlined contract survives where nobody configured codex. A raised
// project budget must not silence that, or the guarantee quietly becomes "on Jinan's laptop".
test("the default-budget gate ignores the configured budget and names the real fix", () => {
  assert.equal(checkDefaultBudget(CODEX_DEFAULT_DOC_BUDGET, []), null);
  const problem = checkDefaultBudget(CODEX_DEFAULT_DOC_BUDGET + 1, []);
  assert.match(problem, /32769 bytes/u);
  assert.match(problem, /move a rule from CORE_FILES to SKILL_SPECS/u);
});

// Codex concatenates EVERY instruction file from the root down to the working directory and
// applies the budget to the combined document. Siblings never compose, so the worst case among
// them is the largest; ancestors DO, and scoring only the largest of a nested pair understated
// the real chain by the whole parent.
test("the budget accounts for the nested docs codex composes onto the root", () => {
  const siblings = [{ file: "a/AGENTS.md", bytes: 1000 }, { file: "b/AGENTS.md", bytes: 2000 }];
  assert.equal(checkDefaultBudget(30000, siblings), null, "30000 + the largest sibling still fits");
  assert.match(checkDefaultBudget(31000, siblings), /composed with b\/AGENTS\.md \(2000\) = 33000/u);

  const chain = [{ file: "a/AGENTS.md", bytes: 1000 }, { file: "a/deep/AGENTS.md", bytes: 900 }];
  const problem = checkDefaultBudget(31000, chain);
  assert.match(problem, /a\/AGENTS\.md \(1000\) \+ a\/deep\/AGENTS\.md \(900\) = 32900/u);
  assert.equal(checkDefaultBudget(30000, chain), null, "30000 + the whole chain still fits");
  assert.equal(checkDefaultBudget(32768, []), null, "no nested docs means no composition");
});

// Counting the largest nested doc is useless if the default stops finding them: swapping
// nestedDocs() for [] left every test green until this one existed.
test("the nested docs codex composes are actually discovered", () => {
  const nested = nestedDocs();
  assert.ok(nested.length >= 4, `expected the package AGENTS.md files, got ${nested.length}`);
  assert.ok(nested.every((doc) => doc.file.endsWith("/AGENTS.md") && doc.bytes > 0));
  assert.ok(nested.some((doc) => doc.file === "packages/model/AGENTS.md"));
  const largest = Math.max(...nested.map((doc) => doc.bytes));
  // Called with no second argument the gate must USE them, not default to nothing.
  assert.ok(largest > 500, "the composition must be big enough for this to bite");
  assert.equal(checkDefaultBudget(CODEX_DEFAULT_DOC_BUDGET - largest), null, "exactly fits");
  assert.match(checkDefaultBudget(CODEX_DEFAULT_DOC_BUDGET - largest + 1), /over the/u);
});

// The whole point of the split: the shipped file has to fit a machine that never configured
// codex. This is the ratchet — re-inlining a rule fails here, not in someone's silent truncation.
test("the shipped AGENTS.md fits the budget codex uses when nothing raised it", () => {
  const bytes = Buffer.byteLength(readFileSync(path.join(ROOT, "AGENTS.md"), "utf8"));
  assert.equal(checkDefaultBudget(bytes), null, `AGENTS.md is ${bytes} bytes`);
});

// git's default pathspec makes `**` require a literal slash, so `.claude/rules/**\/*.md` skipped
// any rule placed directly in .claude/rules/. Asserted against a disposable repo with a known
// layout — re-deriving the expectation with the same git call and the same filter cannot fail.
test("every markdown rule is collected, at any depth, and non-markdown is not", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "muse-src-"));
  execFileSync("git", ["init", "--quiet"], { cwd: dir });
  mkdirSync(path.join(dir, ".claude/rules/deep/deeper"), { recursive: true });
  writeFileSync(path.join(dir, "CLAUDE.md"), "# c\n");
  for (const rel of [".claude/rules/top.md", ".claude/rules/deep/mid.md",
    ".claude/rules/deep/deeper/low.md", ".claude/rules/notes.txt"]) {
    writeFileSync(path.join(dir, rel), "# x\n");
  }
  const listed = spawnSync(process.execPath, ["-e",
    `process.chdir(${JSON.stringify(dir)});`
    + `import(${JSON.stringify(path.join(ROOT, "scripts/build-agents-md.mjs"))})`
    + `.then((m) => process.stdout.write(JSON.stringify(m.sourceFiles())));`,
  ], { cwd: dir, encoding: "utf8" });
  assert.deepEqual(JSON.parse(listed.stdout), [
    "CLAUDE.md",
    ".claude/rules/deep/deeper/low.md",
    ".claude/rules/deep/mid.md",
    ".claude/rules/top.md",
  ]);
  rmSync(dir, { recursive: true, force: true });
});

test("the source set is exactly what Claude Code auto-loads", () => {
  const files = sourceFiles();
  assert.equal(files[0], "CLAUDE.md");
  assert.ok(files.length >= 10, `expected CLAUDE.md plus the rules, got ${files.length}`);
  assert.ok(files.slice(1).every((f) => f.startsWith(".claude/rules/") && f.endsWith(".md")));
  assert.deepEqual(files.slice(1), [...files.slice(1)].sort(), "order must be deterministic");
});

// The property the single-block projection had for free and the split can lose: a rule Claude
// Code loads must reach other agents through SOME layer. This is the gate that keeps it.
test("every auto-loaded rule is assigned to a layer", () => {
  assert.deepEqual(unprojectedSources(), [], "assign each to CORE_FILES or a SKILL_SPECS entry");
});

test("a rule in neither layer is reported rather than dropped", () => {
  assert.deepEqual(unprojectedSources([...sourceFiles(), ".claude/rules/brand/new.md"]), [
    ".claude/rules/brand/new.md",
  ]);
});

// "Exactly one layer" has two halves and only the obvious one was gated. A rule both inlined and
// behind a skill spends the byte budget twice and leaves two copies free to disagree.
test("no rule is projected through more than one layer", () => {
  assert.deepEqual(duplicatedSources(), []);
  const everySource = [...CORE_FILES, ...SKILL_SPECS.flatMap((spec) => spec.sources)];
  assert.equal(new Set(everySource).size, everySource.length, "sources must be distinct");
});

// Inlining is reserved for what a revert cannot undo. Widening it silently is exactly the drift
// this design has to resist, so the membership is asserted rather than left to the constant.
test("only the irreversible boundaries are inlined", () => {
  assert.deepEqual(CORE_FILES, ["CLAUDE.md", ".claude/rules/safety/outbound-safety.md"]);
});

// A description is the ONLY thing an agent sees before deciding whether to open a skill, so an
// empty or vague one silently removes the rule from circulation.
test("every skill declares a distinct name, a trigger-bearing description and real sources", () => {
  const names = new Set();
  for (const spec of SKILL_SPECS) {
    assert.match(spec.name, /^muse-[a-z-]+$/u, `${spec.name} must be a kebab-case muse- name`);
    assert.ok(!names.has(spec.name), `duplicate skill name ${spec.name}`);
    names.add(spec.name);
    assert.ok(spec.description.length > 120, `${spec.name} description is too thin to select on`);
    assert.match(spec.description, /\bUse\b/u, `${spec.name} description must say when to use it`);
    assert.ok(spec.summary.length > 0 && spec.summary.length < 100, `${spec.name} summary`);
    assert.ok(spec.sources.length > 0);
    for (const source of spec.sources) {
      assert.ok(readFileSync(path.join(ROOT, source), "utf8").length > 0, source);
    }
  }
});

/**
 * Compare a source with its projection WITHOUT calling the transform that produced it. Using
 * rewriteLinks to build the expectation made this oracle tautological: an evaluator mutated the
 * transform to truncate every source to 504 characters and every test still passed, because both
 * sides truncated together.
 *
 * Erasing every slashed backtick span was too blunt in the other direction — corrupting
 * `@attunegraph/core` to `CORRUPTED/core` also went unseen. So each side erases only what
 * rewriting actually changes: link targets, and citation spans that ARE a relative path
 * (source side) or a repo-relative path to a real file (projected side). Everything else,
 * `@attunegraph/core` included, must survive byte for byte.
 */
function eraseRewritable(text, base) {
  return text
    // Only a RELATIVE target is rewritten. A URL, mailto, absolute path or bare fragment passes
    // through untouched, so it must compare byte for byte — erasing those too let a mutated
    // arXiv citation survive the whole suite.
    .replace(/\]\(([^)\n]*)\)/gu, (whole, target) =>
      (/^(https?:|mailto:|#|\/)/u.test(target) ? whole : "](P)"))
    .replace(/`([^`\n]+)`/gu, (whole, inner) => {
      if (!/^[\w.-]+(?:\/[\w.-]+)+$/u.test(inner)) return whole;
      // A citation is rewritable only if it names a real file — resolved from the repo root or
      // from the directory the text currently lives in. `@attunegraph/core` names neither, so
      // corrupting it to `CORRUPTED/core` cannot hide here.
      const real = existsSync(path.join(ROOT, inner)) || existsSync(path.resolve(ROOT, base, inner));
      return real ? "`P`" : whole;
    })
    // A frontmatter `related:` entry is a path but neither a link nor a code span, and it is
    // rewritten too. Same predicate: erased only when it names a file that exists.
    .replace(/(^|[\s[,])((?:\.{1,2}\/|[\w.-]+\/)[^\s,\]"']*\.md)/gu, (whole, lead, target) => {
      const real = existsSync(path.join(ROOT, target)) || existsSync(path.resolve(ROOT, base, target));
      return real ? `${lead}P` : whole;
    })
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

/** The text a rendered projection carries for one source, up to the next source marker. */
function projectedSection(rendered, source, sources) {
  const marker = `<!-- source: ${source} -->`;
  const from = rendered.indexOf(marker) + marker.length;
  const nextSource = sources[sources.indexOf(source) + 1];
  const to = nextSource ? rendered.indexOf(`<!-- source: ${nextSource} -->`) : rendered.length;
  // The inlined block separates sources with `---` and ends with its terminator; neither is
  // part of the source text.
  return rendered.slice(from, to).split("\n")
    .filter((line, index, lines) => !(index >= lines.length - 3 && /^(---|<!-- END GENERATED -->)$/u.test(line)))
    .join("\n");
}

// "Verbatim" has to mean the whole body, not a marker and a heading. Every earlier version of
// this assertion passed on a mutilated body: on one truncated after its title, on one whose
// linked lines were all dropped, and on one truncated to 504 characters.
test("a skill body carries its sources verbatim under resolvable frontmatter", () => {
  for (const spec of SKILL_SPECS) {
    const rendered = renderSkill(spec);
    assert.match(rendered, new RegExp(`^---\\nname: ${spec.name}\\ndescription: Use `, "u"));
    for (const source of spec.sources) {
      const body = stripFrontmatter(readFileSync(path.join(ROOT, source), "utf8").trimEnd());
      assert.ok(rendered.includes(`<!-- source: ${source} -->`), `missing marker for ${source}`);
      assert.equal(
        eraseRewritable(projectedSection(rendered, source, spec.sources), `.agents/skills/${spec.name}`),
        eraseRewritable(body, path.dirname(source)),
        `${source} is not carried whole`,
      );
    }
  }
});

// Git stores a symlink as mode 120000, and a checkout with core.symlinks=false — the normal
// Windows configuration, which this repo supports — materialises it as a text file holding the
// target path. Codex then cannot see the skill and the pre-push gate blocks every doc push. So
// everything under .agents is a plain generated file, verified on disk rather than assumed.
test("every workflow skill is copied file for file, never symlinked", () => {
  const skills = workflowSkills();
  assert.ok(skills.includes("grow-muse"), "the repo's own workflow skills must be projected");
  assert.ok(!skills.includes("improve-muse"), "retired workflow skills must not be projected");
  const tree = skillTree();
  for (const name of skills) {
    const sources = workflowSkillFiles(name);
    assert.ok(sources.some((file) => file.endsWith("/SKILL.md")), `${name} needs a SKILL.md`);
    for (const source of sources) {
      const relative = `.agents/skills/${source.slice(".claude/skills/".length)}`;
      // Everything but the paths must survive: a copy is allowed to re-aim a relative link at
      // its new location and nothing else. Verbatim copying broke eleven of them.
      assert.equal(
        eraseRewritable(tree.get(relative)?.file ?? "", path.posix.dirname(relative)),
        eraseRewritable(readFileSync(path.join(ROOT, source), "utf8"), path.posix.dirname(source)),
        `${relative} must carry its source whole`,
      );
      assert.ok(!lstatSync(path.join(ROOT, relative)).isSymbolicLink(), `${relative} must not be a link`);
    }
  }
  // The reference files a workflow skill links to travel with it, or the copy is half a skill.
  assert.ok(tree.has(".agents/skills/loop-creator/references/loop-engineering.md"));
});

// `related:` entries are paths but not links, so the markdown pass never touched them and
// check-doc-links — which does resolve them — failed on the copy.
test("a frontmatter related: path is re-aimed at the copy's location", () => {
  const body = "---\nname: x\nrelated: [../../../harness/contract.md, ./sibling.md]\n---\n\nbody\n";
  const rewritten = rewriteRelated(body, ".claude/skills/a/references", ".agents/skills/a/references");
  assert.match(rewritten, /\.\.\/\.\.\/\.\.\/\.\.\/\.claude\/harness\/contract\.md/u);
  assert.match(rewritten, /\.\.\/\.\.\/\.\.\/\.\.\/\.claude\/skills\/a\/references\/sibling\.md/u);
  assert.match(rewritten, /\nbody\n$/u, "the body below the frontmatter is untouched");
  assert.equal(rewriteRelated("no frontmatter\n", ".claude", ".agents"), "no frontmatter\n");
});

test("the projected tree on disk matches what the generator would write", () => {
  assert.deepEqual(skillTreeDrift(), [], "run pnpm agents:build");
  assert.deepEqual(staleSkillEntries(), []);
});

// A link written in .claude/rules/verification/ resolves against that directory. Inlined at
// the root it would point somewhere else — this is the transform that keeps it honest.
test("a relative link is re-expressed from the repo root", () => {
  assert.equal(
    rewriteLinks("see [x](agent-testing.md)", ".claude/rules/verification"),
    "see [x](.claude/rules/verification/agent-testing.md)",
  );
  assert.equal(
    rewriteLinks("see [x](../../../docs/a.md)", ".claude/rules/verification"),
    "see [x](docs/a.md)",
  );
});

// A skill file sits three levels down, so a root-relative link in its body resolves nowhere —
// including for this repo's own check-doc-links gate, which is what caught it.
test("a link projected into a skill resolves from the skill's own directory", () => {
  assert.equal(
    rewriteLinks("[x](../../../docs/a.md)", ".claude/rules/verification", ".agents/skills/muse-testing"),
    "[x](../../../docs/a.md)",
  );
  assert.equal(
    rewriteLinks("[x](agent-testing.md)", ".claude/rules/verification", ".agents/skills/muse-testing"),
    "[x](../../../.claude/rules/verification/agent-testing.md)",
  );
  assert.equal(
    rewriteLinks("see `../safety/outbound-safety.md`", ".claude/rules/engineering", ".agents/skills/muse-testing"),
    "see `../../../.claude/rules/safety/outbound-safety.md`",
  );
});

// contract.md carries `related: [roles.md, handoff.md, dev-loop.md]`. Projected verbatim it
// landed under the generated frontmatter as body text, where those three paths resolve against
// the skill directory and break — three unresolved references the link gate rejected.
test("a source's own frontmatter is not projected", () => {
  assert.equal(stripFrontmatter("---\nname: x\nrelated: [a.md]\n---\n\n# Title\n"), "# Title\n");
  assert.equal(stripFrontmatter("# Title\n\nbody\n"), "# Title\n\nbody\n", "no frontmatter is untouched");
  // A horizontal rule mid-document is not frontmatter and must survive.
  assert.equal(stripFrontmatter("# T\n\n---\n\nmore\n"), "# T\n\n---\n\nmore\n");
  const rendered = renderSkill(SKILL_SPECS.find((spec) => spec.name === "muse-harness-contract"));
  assert.equal(rendered.split("---\n")[0], "", "the generated frontmatter must open the file");
  assert.ok(!rendered.includes("related: [roles.md"), "the source's own frontmatter must be gone");
});

// A backticked bare path is a citation, not a link. check-doc-links resolves those too, and
// four of them pointed at the source directory until this pass existed.
test("a backticked relative path that resolves is rewritten", () => {
  assert.equal(
    rewriteLinks("see `../safety/outbound-safety.md` first", ".claude/rules/engineering"),
    "see `.claude/rules/safety/outbound-safety.md` first",
  );
});

test("a backticked path that resolves to nothing is left alone", () => {
  const shell = "run `../scripts/does-not-exist.sh`";
  assert.equal(rewriteLinks(shell, ".claude/rules"), shell);
  assert.equal(rewriteLinks("`cd ..` then build", ".claude/rules"), "`cd ..` then build");
});

test("a fragment survives the rewrite", () => {
  assert.equal(
    rewriteLinks("[x](testing.md#gates)", ".claude/rules/verification"),
    "[x](.claude/rules/verification/testing.md#gates)",
  );
});

// A bare #fragment resolves inside AGENTS.md because the heading it names is inlined too.
test("urls, absolute paths and bare fragments are left alone", () => {
  for (const target of ["https://x.dev/a", "mailto:a@b.c", "/abs/p.md", "#appendix"]) {
    assert.equal(rewriteLinks(`[x](${target})`, ".claude/rules"), `[x](${target})`);
  }
});

test("every inlined file's text lands in the block verbatim, and nothing else does", () => {
  const block = renderBlock();
  for (const file of CORE_FILES) {
    const body = stripFrontmatter(readFileSync(`${ROOT}/${file}`, "utf8").trimEnd());
    assert.ok(block.includes(`<!-- source: ${file} -->`), `missing marker for ${file}`);
    assert.equal(
      eraseRewritable(projectedSection(block, file, CORE_FILES), ""),
      eraseRewritable(body, path.dirname(file)),
      `${file} is not carried whole`,
    );
  }
  for (const spec of SKILL_SPECS) {
    for (const source of spec.sources) {
      assert.ok(!block.includes(`<!-- source: ${source} -->`), `${source} belongs in a skill, not inline`);
    }
  }
});

test("the block advertises every skill so a reader who resolves none still finds them", () => {
  const block = renderBlock();
  for (const spec of SKILL_SPECS) {
    assert.ok(block.includes(`.agents/skills/${spec.name}/SKILL.md`), `${spec.name} is unadvertised`);
  }
  for (const name of workflowSkills()) assert.ok(block.includes(name), `${name} is unadvertised`);
});

test("regenerating replaces the block rather than appending a second one", () => {
  const once = compose("intro\n", "<<BLOCK>>");
  assert.match(once, /intro/u);
  const composed = compose(
    `intro\n\n${renderBlock()}\n\ntail\n`,
    renderBlock(),
  );
  assert.equal(composed.split("<!-- END GENERATED -->").length - 1, 1);
  assert.match(composed, /tail/u);
});

test("a BEGIN with no END is an error, not a silent overwrite", () => {
  const begin = renderBlock().split("\n")[0];
  assert.throws(() => compose(`a\n${begin}\nb\n`, "x"), /no END marker/u);
});

// compose() ends the block at the first END it finds after BEGIN, so an END inside the body
// would cut it short and orphan the remainder mid-file. A draft of the block's own intro did
// exactly that, appending a second copy of everything below it.
test("the block never terminates itself early", () => {
  const block = renderBlock();
  assert.equal(block.split("<!-- END GENERATED -->").length - 1, 1);
  assert.ok(block.trimEnd().endsWith("<!-- END GENERATED -->"));
});

// The generated block sits mid-file now, so the truncation self-check the prelude tells a reader
// to run needs a marker that IS last — and one the build maintains rather than a hand-written
// line that rots the moment a section is appended below it.
test("the sentinel is placed last and is not duplicated by a rebuild", () => {
  assert.equal(ensureSentinel("a\nb\n"), `a\nb\n\n${SENTINEL}\n`);
  assert.equal(ensureSentinel(`a\n\n${SENTINEL}\n`), `a\n\n${SENTINEL}\n`);
  // A sentinel stranded mid-file by an appended section moves back to the end rather than doubling.
  assert.equal(ensureSentinel(`a\n${SENTINEL}\nnew section\n`), `a\nnew section\n\n${SENTINEL}\n`);
  const shipped = readFileSync(path.join(ROOT, "AGENTS.md"), "utf8");
  assert.ok(shipped.trimEnd().endsWith(SENTINEL), "the shipped file must end with the sentinel");
  assert.equal(shipped.split(SENTINEL).length - 1, 1);
});

/** A disposable repo carrying exactly the paths the projection expects, and nothing more. */
function makeProbeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "muse-agents-"));
  execFileSync("git", ["init", "--quiet"], { cwd: dir });
  const write = (rel, body) => {
    mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  };
  for (const file of CORE_FILES) write(file, `# ${file}\n\nINLINE_${path.basename(file, ".md")}\n`);
  for (const spec of SKILL_SPECS) {
    for (const source of spec.sources) write(source, `# ${source}\n\nSKILL_${spec.name}\n`);
  }
  write("AGENTS.md", "# brief\n\nintro\n");
  write(".claude/skills/probe-workflow/SKILL.md", "---\nname: probe-workflow\ndescription: probe\n---\n");
  write(".claude/skills/probe-workflow/references/evals.md", "# probe evals\n");
  write("scripts/build-agents-md.mjs", "// generator stand-in\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  return dir;
}

const runCli = (dir, ...args) =>
  spawnSync(process.execPath, [path.join(ROOT, "scripts/build-agents-md.mjs"), ...args], {
    cwd: dir,
    encoding: "utf8",
  });

/** publicationDrift() evaluated inside a probe repo rather than this one. */
const publicationDriftIn = (dir) => {
  const module = JSON.stringify(path.join(ROOT, "scripts/build-agents-md.mjs"));
  const run = spawnSync(process.execPath, ["-e",
    `process.chdir(${JSON.stringify(dir)});`
    + `import(${module}).then((m) => process.stdout.write(JSON.stringify(m.publicationDrift())));`,
  ], { cwd: dir, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
};

/** Build, then stage — an unstaged projection is correctly reported as unpublished. */
const buildAndStage = (dir) => {
  const built = runCli(dir);
  execFileSync("git", ["add", "-A"], { cwd: dir });
  return built;
};

// The gate this file exists for. It runs the real CLI in a disposable repo and asserts the
// EXIT CODE: an earlier version of this test re-implemented the comparison in a subprocess, so
// mutating process.exit(1) to exit(0) in the --check branch left the whole suite green.
test("the --check CLI exits 1 on a stale projection and 0 on a current one", () => {
  const dir = makeProbeRepo();
  assert.equal(runCli(dir, "--check").status, 1, "an unprojected AGENTS.md must fail --check");
  assert.equal(buildAndStage(dir).status, 0);

  const built = readFileSync(path.join(dir, "AGENTS.md"), "utf8");
  assert.ok(built.includes("INLINE_CLAUDE") && built.includes("INLINE_outbound-safety"));
  assert.ok(!built.includes("SKILL_muse-testing"), "a skill body must not be inlined");
  const skill = readFileSync(path.join(dir, ".agents/skills/muse-testing/SKILL.md"), "utf8");
  assert.ok(skill.includes("SKILL_muse-testing"), "the skill body must land on disk");
  assert.equal(runCli(dir, "--check").status, 0, "a freshly built projection must pass --check");

  // Editing a rule stales the SKILL.md, not AGENTS.md — the half a single-block check would miss.
  writeFileSync(path.join(dir, ".claude/rules/verification/testing.md"), "# t\n\nSKILL_CHANGED\n");
  const stale = runCli(dir, "--check");
  assert.equal(stale.status, 1, "an edited rule must stale the projection");
  assert.match(stale.stderr, /muse-testing\/SKILL\.md is out of date/u);
  rmSync(dir, { recursive: true, force: true });
});

test("a rule assigned to no layer fails the build instead of vanishing", () => {
  const dir = makeProbeRepo();
  assert.equal(buildAndStage(dir).status, 0);
  writeFileSync(path.join(dir, ".claude/rules/orphan.md"), "# orphan\n\nORPHAN\n");
  const orphaned = runCli(dir);
  assert.equal(orphaned.status, 1, "an unassigned rule must fail the build");
  assert.match(orphaned.stderr, /\.claude\/rules\/orphan\.md/u);
  assert.match(orphaned.stderr, /CORE_FILES|SKILL_SPECS/u);
  rmSync(dir, { recursive: true, force: true });
});

// The budget check used to print and continue. pre-push runs --check and nothing else, so an
// oversized AGENTS.md could regenerate, warn into a log nobody reads, and push green.
test("an over-budget projection fails the command, not just the log", () => {
  const dir = makeProbeRepo();
  assert.equal(buildAndStage(dir).status, 0);
  writeFileSync(path.join(dir, "CLAUDE.md"), `# c\n\n${"padding line\n".repeat(3000)}`);
  const built = runCli(dir);
  assert.equal(built.status, 1, "regenerating an oversized projection must fail");
  assert.match(built.stderr, /over the 32768-byte budget/u);
  assert.match(built.stderr, /move a rule from CORE_FILES to SKILL_SPECS/u);
  // And it stays failed for the gate that actually runs on push.
  assert.equal(runCli(dir, "--check").status, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("a rule projected through two layers is reported rather than sent twice", () => {
  const doubled = [...CORE_FILES, ".claude/rules/verification/testing.md", CORE_FILES[0]];
  assert.deepEqual(duplicatedSources(doubled), [CORE_FILES[0]]);
  assert.deepEqual(duplicatedSources([...CORE_FILES]), [], "a clean assignment reports nothing");
  assert.deepEqual(duplicatedSources([]), []);
});

// A file left inside a generated skill directory keeps being offered to the model, and a
// comparison that only walks the paths it EXPECTS is blind to it.
test("an unexpected file inside a generated skill directory is reported and removed", () => {
  const dir = makeProbeRepo();
  assert.equal(buildAndStage(dir).status, 0);
  writeFileSync(path.join(dir, ".agents/skills/muse-testing/OLD.md"), "stale\n");
  const drifted = runCli(dir, "--check");
  assert.equal(drifted.status, 1);
  assert.match(drifted.stderr, /muse-testing\/OLD\.md is no longer projected/u);
  assert.equal(buildAndStage(dir).status, 0);
  assert.equal(runCli(dir, "--check").status, 0, "rebuilding must remove it");
  rmSync(dir, { recursive: true, force: true });
});

// Drift was measured against the working tree alone, so a commit that added AGENTS.md and forgot
// .agents passed pre-push and left every fresh checkout with no skills at all.
test("a projection that was never committed is reported as unpublished", () => {
  const dir = makeProbeRepo();
  assert.equal(runCli(dir).status, 0, "building alone must succeed");
  const unstaged = runCli(dir, "--check");
  assert.equal(unstaged.status, 1, "an untracked projection is not published");
  assert.match(unstaged.stderr, /muse-testing\/SKILL\.md is not tracked by git/u);
  execFileSync("git", ["add", "-A"], { cwd: dir });
  assert.equal(runCli(dir, "--check").status, 0, "staging it makes it publishable");
  rmSync(dir, { recursive: true, force: true });
});

// A generated skill directory replaced by a symlink was DESCENDED, so the rebuild would write
// and delete through it — outside .agents entirely. It is not a directory this projection owns.
test("a generated skill directory replaced by a symlink is not walked through", () => {
  const dir = makeProbeRepo();
  assert.equal(buildAndStage(dir).status, 0);
  const outside = mkdtempSync(path.join(tmpdir(), "muse-outside-"));
  writeFileSync(path.join(outside, "SKILL.md"), "---\nname: muse-testing\n---\n");
  writeFileSync(path.join(outside, "KEEP.md"), "must survive\n");
  rmSync(path.join(dir, ".agents/skills/muse-testing"), { recursive: true, force: true });
  symlinkSync(outside, path.join(dir, ".agents/skills/muse-testing"));

  const drifted = runCli(dir, "--check");
  assert.equal(drifted.status, 1, "a symlinked skill directory is drift, not a directory to walk");
  assert.match(drifted.stderr, /muse-testing is no longer projected/u);
  assert.equal(runCli(dir).status, 0);
  assert.ok(existsSync(path.join(outside, "KEEP.md")), "nothing outside .agents may be deleted");
  assert.ok(!lstatSync(path.join(dir, ".agents/skills/muse-testing")).isSymbolicLink());
  rmSync(outside, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

// The directory guard did not cover the file: a planted SKILL.md symlink was followed by
// writeFileSync, so `agents:build` exited 0 and wrote the generated body outside .agents.
test("a generated SKILL.md replaced by a symlink is not written through", () => {
  const dir = makeProbeRepo();
  assert.equal(buildAndStage(dir).status, 0);
  const outside = mkdtempSync(path.join(tmpdir(), "muse-outside-"));
  const target = path.join(outside, "SKILL.md");
  writeFileSync(target, "MUST NOT BE OVERWRITTEN\n");
  const planted = path.join(dir, ".agents/skills/muse-testing/SKILL.md");
  rmSync(planted, { force: true });
  symlinkSync(target, planted);

  const drifted = runCli(dir, "--check");
  assert.equal(drifted.status, 1, "a symlinked SKILL.md is drift");
  assert.match(drifted.stderr, /muse-testing\/SKILL\.md is a symlink, not a generated file/u);
  assert.equal(runCli(dir).status, 0);
  assert.equal(readFileSync(target, "utf8"), "MUST NOT BE OVERWRITTEN\n", "nothing outside .agents may be written");
  assert.ok(!lstatSync(planted).isSymbolicLink(), "the planted link must be replaced by a real file");
  rmSync(outside, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

// pre-push validates the COMMIT, not the working tree. A commit carrying a changed rule with the
// previous SKILL.md, the regenerated one left unstaged, passed every content comparison.
test("a projection rebuilt but never committed is reported", () => {
  const dir = makeProbeRepo();
  assert.equal(buildAndStage(dir).status, 0);
  execFileSync("git", ["commit", "-qm", "base"], { cwd: dir });
  assert.deepEqual(publicationDriftIn(dir), [], "a committed projection is published");

  writeFileSync(path.join(dir, ".claude/rules/verification/testing.md"), "# t\n\nCHANGED\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "rule only"], { cwd: dir });
  assert.equal(runCli(dir).status, 0, "rebuilding fixes the working tree");
  const drifted = runCli(dir, "--check");
  assert.equal(drifted.status, 1, "the commit still carries the old projection");
  assert.match(drifted.stderr, /differs between HEAD and the working tree/u);
  rmSync(dir, { recursive: true, force: true });
});

// The mirror of the case above, and the reason a differing SOURCE can no longer be excused:
// commit the regenerated SKILL.md, leave the rule uncommitted, and HEAD carries a projection of
// text it does not contain. The working tree is entirely consistent, so only HEAD can tell.
test("a source left uncommitted under a committed projection is reported", () => {
  const dir = makeProbeRepo();
  assert.equal(buildAndStage(dir).status, 0);
  execFileSync("git", ["commit", "-qm", "base"], { cwd: dir });

  writeFileSync(path.join(dir, ".claude/rules/verification/testing.md"), "# t\n\nCHANGED\n");
  assert.equal(runCli(dir).status, 0, "the projection now matches the working-tree rule");
  execFileSync("git", ["add", "--", "AGENTS.md", ".agents"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "projection only"], { cwd: dir });

  const drifted = runCli(dir, "--check");
  assert.equal(drifted.status, 1, "HEAD projects a rule HEAD does not carry");
  assert.match(drifted.stderr, /testing\.md differs between HEAD and the working tree/u);
  rmSync(dir, { recursive: true, force: true });
});

// The generator is an input like any rule: committing outputs while leaving a changed
// build-agents-md.mjs behind ships a projection produced by a version nobody published.
test("a generator left uncommitted under committed outputs is reported", () => {
  const dir = makeProbeRepo();
  assert.equal(buildAndStage(dir).status, 0);
  execFileSync("git", ["commit", "-qm", "base"], { cwd: dir });
  assert.equal(runCli(dir, "--check").status, 0);

  writeFileSync(path.join(dir, "scripts/build-agents-md.mjs"), "// changed\n");
  const drifted = runCli(dir, "--check");
  assert.equal(drifted.status, 1, "the published outputs came from an unpublished generator");
  assert.match(drifted.stderr, /scripts\/build-agents-md\.mjs differs between HEAD/u);
  rmSync(dir, { recursive: true, force: true });
});

// A linked skill is a symlink into .claude/skills. Publishing the link without its target
// clones as a dangling link, and the skill exists only on the machine that built it.
test("a linked skill whose target is untracked is reported", () => {
  const dir = makeProbeRepo();
  assert.equal(buildAndStage(dir).status, 0);
  execFileSync("git", ["commit", "-qm", "base"], { cwd: dir });
  assert.equal(runCli(dir, "--check").status, 0, "the target is tracked");

  execFileSync("git", ["rm", "-q", "--cached", "--", ".claude/skills/probe-workflow/SKILL.md"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "drop the target"], { cwd: dir });
  const drifted = runCli(dir, "--check");
  assert.equal(drifted.status, 1, "the link would clone dangling");
  assert.match(drifted.stderr, /probe-workflow\/SKILL\.md is not tracked by git/u);
  rmSync(dir, { recursive: true, force: true });
});

// A skill is its whole directory. Untracking only a reference file left the working tree intact
// and every local gate green, while a fresh clone got a skill whose own links were broken.
test("a linked skill's reference files must be published too", () => {
  const dir = makeProbeRepo();
  assert.equal(buildAndStage(dir).status, 0);
  execFileSync("git", ["commit", "-qm", "base"], { cwd: dir });
  assert.equal(runCli(dir, "--check").status, 0, "the whole tree is tracked");

  const auxiliary = ".claude/skills/probe-workflow/references/evals.md";
  execFileSync("git", ["rm", "-q", "--cached", "--", auxiliary], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "drop a reference file"], { cwd: dir });
  assert.ok(existsSync(path.join(dir, auxiliary)), "the file is still here locally — that is the trap");

  const drifted = runCli(dir, "--check");
  assert.equal(drifted.status, 1, "a fresh clone would get the skill without its references");
  assert.match(drifted.stderr, /references\/evals\.md is not tracked by git/u);
  rmSync(dir, { recursive: true, force: true });
});

// A renamed or deleted skill leaves its old directory behind, and a stale SKILL.md keeps being
// offered to the model — the failure mode a content-only comparison cannot see.
test("a skill directory the projection no longer owns is reported and removed", () => {
  const dir = makeProbeRepo();
  assert.equal(buildAndStage(dir).status, 0);
  mkdirSync(path.join(dir, ".agents/skills/muse-retired"), { recursive: true });
  writeFileSync(path.join(dir, ".agents/skills/muse-retired/SKILL.md"), "---\nname: muse-retired\n---\n");
  const drifted = runCli(dir, "--check");
  assert.equal(drifted.status, 1);
  assert.match(drifted.stderr, /muse-retired\/SKILL\.md is no longer projected/u);
  assert.equal(buildAndStage(dir).status, 0);
  assert.equal(runCli(dir, "--check").status, 0, "rebuilding must remove it");
  rmSync(dir, { recursive: true, force: true });
});
