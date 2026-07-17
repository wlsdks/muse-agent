// Ledger format gate — the two backlog ledgers must stay machine-parseable
// and symbol-free so their records are usable as analysis data (owner
// directive 2026-07-17). Grammar per record line:
//   - [status] [YYYY-MM-DD] [key=value ...] [:: free text]
// status ∈ open|done|blocked|decision|rejected|superseded. Indented lines
// are free detail prose. Section headers (##) and blockquotes are free.
import { readFileSync } from "node:fs";

const FILES = ["docs/goals/backlog.md", "docs/goals/backlog-archive.md"];
const BANNED = /[★◦✓✅⚠⏳⛔✗✔①②③④⑤⑥⑦⑧⑨→\u{1F000}-\u{1FAFF}\u23F8\u2696\u24D8\u25D1]/u;
const RECORD = /^- \[(open|done|blocked|decision|rejected|superseded)\](\s+\d{4}-\d{2}-\d{2})?(\s+[a-z-]+=("[^"]*"|\S+))*(\s+::\s+.*)?$/u;

const KINDS = new Set(["fix", "feat", "test", "docs", "guard", "scout", "security", "perf", "reliability", "refactor"]);
// commit= is mandatory on [done] records dated on/after the template's
// enforcement date — historical bare records stay valid (text-only data).
const COMMIT_REQUIRED_FROM = "2026-07-18";
// A record-shaped line hiding at an indent dodges both the grammar check and
// anchored analysis greps — records live at column 0, details are prose.
const INDENTED_RECORD = /^\s+- \[(open|done|blocked|decision|rejected|superseded)\]/u;

let errors = 0;
for (const file of FILES) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    const where = `${file}:${i + 1}`;
    const banned = line.match(BANNED);
    if (banned) { console.error(`${where}: banned symbol '${banned[0]}'`); errors++; }
    if (INDENTED_RECORD.test(line)) {
      console.error(`${where}: record-shaped line at an indent — records live at column 0, details are plain prose: ${line.slice(0, 80)}`);
      errors++;
      return;
    }
    if (!line.startsWith("- ")) return;
    if (!RECORD.test(line)) {
      console.error(`${where}: top-level record does not match the ledger grammar: ${line.slice(0, 80)}`);
      errors++;
      return;
    }
    const head = line.split(" :: ")[0];
    const kind = head.match(/\bkind=(\S+)/u);
    if (kind && !KINDS.has(kind[1])) {
      console.error(`${where}: kind='${kind[1]}' outside the closed set [${[...KINDS].join("|")}]`);
      errors++;
    }
    const date = line.match(/^- \[done\]\s+(\d{4}-\d{2}-\d{2})/u);
    if (date && date[1] >= COMMIT_REQUIRED_FROM && !/\bcommit=[0-9a-f]{7,}/u.test(head)) {
      console.error(`${where}: [done] record dated ${date[1]} must carry commit=<sha>`);
      errors++;
    }
  });
}
if (errors > 0) { console.error(`\nledger-format: ${errors} violation(s)`); process.exit(1); }
console.log("ledger-format: clean");
