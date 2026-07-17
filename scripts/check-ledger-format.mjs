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

let errors = 0;
for (const file of FILES) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    const where = `${file}:${i + 1}`;
    const banned = line.match(BANNED);
    if (banned) { console.error(`${where}: banned symbol '${banned[0]}'`); errors++; }
    if (line.startsWith("- ") && !RECORD.test(line)) {
      console.error(`${where}: top-level record does not match the ledger grammar: ${line.slice(0, 80)}`);
      errors++;
    }
  });
}
if (errors > 0) { console.error(`\nledger-format: ${errors} violation(s)`); process.exit(1); }
console.log("ledger-format: clean");
