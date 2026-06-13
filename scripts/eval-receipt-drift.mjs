// Differentiation proof battery — the source receipt verifies its quote against
// the FILE ON DISK at render time, not the retrieval-index copy.
//
// Muse's "📎 From your notes (open to verify)" receipt draws its verbatim snippet
// from the embedded/retrieval-index copy of a note. A note edited or DELETED after
// indexing would otherwise still get a confident verbatim quote + an "open to
// verify" path pointing at text the file no longer contains — the *fake citation*
// the grounded-attribution literature warns about (AIS: a citation is only honest
// when the snippet actually supports the claim). Rivals cite from their embedded
// copy by construction (that IS their RAG architecture) and have no product reason
// to re-read every source at render time; Muse is single-user, local-by-construction,
// and "shows its work" IS the product, so re-reading the user's own local note to
// keep the receipt honest is cheap and on-brand.
//
// formatSourceReceipts now accepts a caller-supplied disk-content map and, on
// drift, HIDES the stale quote and says why instead of vouching for it. This
// battery drives the REAL formatSourceReceipts with REAL temp files (write → read
// into the map → assert) so the disk-read → verify → downgrade path is proven
// end-to-end, deterministically (no Ollama).
//
// Run: pnpm eval:receipt-drift   (builds @muse/recall first via package.json)

import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { formatSourceReceipts } from "../packages/recall/dist/index.js";

let failures = 0;
function check(label, condition) {
  console[condition ? "log" : "error"](`  ${condition ? "✓" : "✗"} ${label}`);
  if (!condition) failures += 1;
}

const dir = mkdtempSync(join(tmpdir(), "muse-receipt-drift-"));
// Read the file's CURRENT content into the map the way a caller would (null = gone).
const diskContentOf = (file) => {
  const path = join(dir, file);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
};

const INDEXED = "WireGuard uses 1420 MTU on most links."; // the retrieval-index copy
const answer = "MTU is 1420 [from vpn.md]. Cat is Mochi [from pets.md].";
const chunks = [
  { file: "vpn.md", text: INDEXED },
  { file: "pets.md", text: "My cat is named Mochi." }
];

try {
  // ── 1. Faithful: disk still contains the indexed line → quote shown ──────────
  writeFileSync(join(dir, "vpn.md"), INDEXED);
  writeFileSync(join(dir, "pets.md"), "My cat is named Mochi.");
  let disk = new Map([["vpn.md", diskContentOf("vpn.md")], ["pets.md", diskContentOf("pets.md")]]);
  let out = formatSourceReceipts(answer, dir, chunks, undefined, undefined, disk) ?? "";
  check("faithful note (disk still has the line) ⇒ verbatim quote shown", out.includes(`"${INDEXED}"`));

  // ── 2. Drift (the teeth): note edited after indexing → stale quote HIDDEN ─────
  writeFileSync(join(dir, "vpn.md"), "WireGuard now uses 1500 MTU after the rewrite.");
  disk = new Map([["vpn.md", diskContentOf("vpn.md")], ["pets.md", diskContentOf("pets.md")]]);
  out = formatSourceReceipts(answer, dir, chunks, undefined, undefined, disk) ?? "";
  check("drifted note (line no longer on disk) ⇒ stale quote NOT shown (no fake citation)", !out.includes(`"${INDEXED}"`));
  check("...and the drift is surfaced honestly ('changed since')", out.includes("changed since"));
  check("...no-collateral: the still-faithful pets.md keeps its quote", out.includes(`"My cat is named Mochi."`));

  // ── 3. Deleted source: file removed after indexing → absence surfaced ────────
  rmSync(join(dir, "vpn.md"));
  disk = new Map([["vpn.md", diskContentOf("vpn.md")], ["pets.md", diskContentOf("pets.md")]]);
  out = formatSourceReceipts(answer, dir, chunks, undefined, undefined, disk) ?? "";
  check("deleted source ⇒ quote NOT shown", !out.includes(`"${INDEXED}"`));
  check("...and the absence is surfaced ('no longer on disk')", out.includes("no longer on disk"));

  // ── 4. Backward-compat: no disk map ⇒ unchanged (index-copy quote shown) ─────
  out = formatSourceReceipts(answer, dir, chunks) ?? "";
  check("no disk map supplied ⇒ unchanged behaviour (index-copy quote shown)", out.includes(`"${INDEXED}"`));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n[eval:receipt-drift] FAIL — ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\n[eval:receipt-drift] PASS — the receipt verifies its quote against the file on disk; a drifted/deleted source is caught, not quoted");
