#!/usr/bin/env node
// Generates docs/test-report.json for the dashboard's /tests view.
//
// Runs the whole workspace test suite once, parses pnpm's per-package
// summary lines, and pairs that with the test-hardening branch's
// test:/fix: commit history. Written once per loop iteration; the
// read-only dashboard renders the JSON without re-running anything.

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd: repoRoot, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      // The suite exits non-zero on a failing test; we still want the
      // captured output, so resolve on both paths.
      (err, stdout, stderr) => resolve(`${stdout ?? ""}\n${stderr ?? ""}${err && !stdout ? `\n${err.message}` : ""}`),
    );
  });
}

// pnpm -r --stream prefixes each line with "<pkg-dir> <script>: ".
// Vitest prints a per-run summary like:
//   "Tests  919 passed (919)"  /  "Tests  2 passed | 342 skipped (344)"
//   "Tests  1 failed | 22 passed (23)"
function parsePackages(output) {
  const byPkg = new Map();
  const num = (line, label) => {
    const m = new RegExp(`(\\d+)\\s+${label}`, "u").exec(line);
    return m ? Number(m[1]) : 0;
  };
  for (const rawLine of output.split("\n")) {
    const prefix = /^(\S+)\s+test:\s+(.*)$/u.exec(rawLine);
    if (!prefix) continue;
    const pkg = prefix[1];
    const body = prefix[2];
    if (/^Tests\b/u.test(body) && /\(\d+\)/u.test(body)) {
      byPkg.set(pkg, {
        name: pkg,
        passed: num(body, "passed"),
        failed: num(body, "failed"),
        skipped: num(body, "skipped"),
      });
    }
  }
  return [...byPkg.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function commits() {
  const SEP = String.fromCharCode(1);
  const raw = await run("git", ["log", "-60", "--no-merges", `--pretty=format:%h${SEP}%cI${SEP}%s`], 5000);
  const out = [];
  for (const line of raw.split("\n")) {
    const [hash, iso, subject = ""] = line.split(SEP);
    if (!hash || !iso) continue;
    const type = /^(test|fix|refactor|feat)(\(|:)/u.exec(subject)?.[1];
    if (type !== "test" && type !== "fix" && type !== "refactor") continue;
    out.push({ hash, when: iso.slice(0, 16).replace("T", " "), subject, type });
  }
  return out;
}

// Build first: a stale dist (e.g. right after merging main) makes
// cross-package imports run against old code and reports phantom
// failures. The suite must run against fresh output.
await run("pnpm", ["build"], 420_000);
const suiteOutput = await run("pnpm", ["-r", "--stream", "test"], 300_000);
const packages = parsePackages(suiteOutput);
const history = await commits();
const totals = packages.reduce(
  (acc, p) => ({ passed: acc.passed + p.passed, failed: acc.failed + p.failed, skipped: acc.skipped + p.skipped }),
  { passed: 0, failed: 0, skipped: 0 },
);

const report = {
  generatedAt: new Date().toISOString(),
  totals: { ...totals, packages: packages.length },
  packages,
  commits: history,
};

await writeFile(join(repoRoot, "docs/test-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(
  `wrote docs/test-report.json — ${totals.passed} passed, ${totals.failed} failed, ${totals.skipped} skipped across ${packages.length} packages; ${history.length} hardening commits\n`,
);

// Sanity: a generator that silently captured zero packages is useless.
if (packages.length === 0) {
  process.stderr.write("warning: parsed 0 package summaries — pnpm output format may have changed\n");
}
// Read back to confirm the file is valid JSON (fail loud if not).
JSON.parse(await readFile(join(repoRoot, "docs/test-report.json"), "utf8"));
