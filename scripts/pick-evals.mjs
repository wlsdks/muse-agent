/**
 * pick-evals — the diff→battery map, as CODE (not "reason it from the ~30-script menu").
 *
 *   node scripts/pick-evals.mjs            # batteries for the uncommitted working tree
 *   node scripts/pick-evals.mjs <base>     # batteries for the diff vs <base> (e.g. main)
 *
 * The improve-muse VERIFY step says "map the diff → the exact eval/smoke subset". That map
 * used to live only in the operator's head — the exact friction the dev loop exists to kill.
 * This is that map in version control: given the changed files, it PRINTS the required
 * battery commands (with MUSE_EVAL_REPEAT=3 already set on grounding/safety-critical ones so
 * pass^k happens mechanically, not from the agent remembering). Run what it prints.
 *
 * Add a row when you add a surface; this file is the single place the mapping is owned.
 */

import { execSync } from "node:child_process";

const base = process.argv[2];
const range = base ? `${base}...HEAD` : "HEAD";

let changed = [];
try {
  // committed diff vs base, OR uncommitted (staged + unstaged) working-tree changes.
  const cmd = base ? `git diff --name-only ${range}` : "git diff --name-only HEAD";
  changed = execSync(cmd, { encoding: "utf8" }).split("\n").map((s) => s.trim()).filter(Boolean);
} catch {
  console.error("pick-evals: could not read git diff (not a repo?).");
  process.exit(2);
}

if (changed.length === 0) {
  console.log("pick-evals: no changes — nothing to verify.");
  process.exit(0);
}

// Each rule: a path matcher → the batteries that surface must clear. `passK` prefixes
// MUSE_EVAL_REPEAT=3 (grounding/safety/tool-selection are stochastic — pass^k is the gate).
const RULES = [
  { test: (f) => /packages\/tools\/|tool-?(filter|projection|registry)|adapter-ollama/i.test(f),
    evals: ["eval:tools"], passK: true, why: "tool names/descriptions/schemas/projection/adapter → one-shot tool selection" },
  { test: (f) => /knowledge-recall|grounding|citation|rubric|reverify|recall|chat-grounding|faithful/i.test(f),
    evals: ["precheck:grounding", "eval:grounding-delta"], passK: true, why: "grounding gate / recall / citation → fabrication=0 floor + architectural Δ" },
  { test: (f) => /vision|image|multimodal/i.test(f),
    evals: ["eval:vision"], passK: false, why: "vision surface → grounded-vision routing" },
  { test: (f) => /multi-agent|council|orchestrat|supervisor|handoff/i.test(f),
    evals: ["eval:self-improving"], passK: false, why: "multi-agent/council surface → self-improving battery bundle" },
  { test: (f) => /packages\/prompts\/|plan-execute|plan-quality/i.test(f),
    evals: ["eval:plan-quality"], passK: false, why: "prompts / plan-execute → plan quality" },
  { test: (f) => /guard|injection|adversar|outbound|approval|policy/i.test(f),
    evals: ["eval:adversarial"], passK: true, why: "guards / injection / outbound / approval → must-refuse safety" },
  { test: (f) => /packages\/model\/|provider|adapter/i.test(f),
    evals: ["smoke:live", "eval:tools"], passK: false, why: "model adapter / provider → real round-trip + selection" },
  { test: (f) => /memory|episodic|playbook|skill-merge|preference|pattern|correction/i.test(f),
    evals: ["eval:self-improving"], passK: false, why: "memory / playbook / self-improvement path → self-improving bundle" },
];

const picked = new Map(); // command → {passK, whys:Set}
for (const f of changed) {
  for (const rule of RULES) {
    if (!rule.test(f)) continue;
    for (const e of rule.evals) {
      const cur = picked.get(e) ?? { passK: false, whys: new Set() };
      cur.passK = cur.passK || rule.passK;
      cur.whys.add(rule.why);
      picked.set(e, cur);
    }
  }
}

// Cross-package change → full build+test integration check (stale-dist tax + type errors in tests).
const touchedPackages = new Set(
  changed.map((f) => /^(packages|apps)\/([^/]+)\//.exec(f)?.[2]).filter(Boolean)
);
const crossPackage = touchedPackages.size > 1;

console.log(`# pick-evals — ${changed.length} changed file(s), ${touchedPackages.size} package(s)\n`);
console.log("pnpm lint            # always (0 errors required)");
if (crossPackage) {
  console.log("pnpm check           # cross-package change → build+test every workspace (stale dist masquerades as a bug)");
}
if (picked.size === 0) {
  console.log("# no surface-specific battery matched — lint + (cross-package) check is the gate. Add a RULES row if a surface is missing.");
} else {
  console.log("");
  for (const [cmd, { passK, whys }] of picked) {
    const prefix = passK ? "MUSE_EVAL_REPEAT=3 " : "";
    console.log(`${prefix}pnpm ${cmd}`.padEnd(40) + `# ${[...whys].join("; ")}`);
  }
}
console.log("\n# Invariants on every slice: fabrication=0 (on real traces too), lint 0/0, changed-package test green.");
