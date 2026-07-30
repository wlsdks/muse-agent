import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { assertCandidate, materializeCommandMatrix } from "./run-attunegraph-rename-verification.mjs";

const canonicalIdentities = [
  "ATG1",
  "0x41544731",
  ".atgx",
  "attunegraph_projection_journal",
  "attunegraph_projection_head",
  "attunegraph_projection_journal_generation",
  "attunegraph_portable_validation_scope",
  "attunegraph_portable_validation_head_seen",
  "attunegraph-portable",
  "attunegraph-portable-limits@1",
  "attunegraph.canonical-projection.v1",
  "attunegraph.store-projection.v1",
  "attunegraph.portable-record.v1",
  "attunegraph.portable-state.v1",
  "attunegraph-observation:",
  "attunegraph-commit:",
  "attunegraph-store:",
  "attunegraph-portable-record:",
  "attunegraph-state:",
  ".attunegraph-admin-lease-v1.json",
  "attunegraph-admin-validation-v1-",
  "attunegraph-local-protocol",
  "attunegraph.sqlite",
  "ATTUNEGRAPH_INPUT_TYPE_CHILD",
  "attunegraph-local-runtime-manifest.json",
  "attunegraph-portable-fixtures",
  "attunegraph.assertion",
  "attunegraph.candidate-inventory.v1",
  "attunegraph.candidate-settlement-ledger.v1",
  "attunegraph.candidate-settlement-capacity-error.v1",
  "attunegraph-candidate-inventory:sha256:",
  "attunegraph-candidate-ledger:sha256:",
  "attunegraph-candidate-capacity-error:sha256:",
  "attunegraph-canonical-json-utf16@1",
  "attunegraph.canonical-envelope.fixture.v1",
  "attunegraph-envelope:test:sha256:",
  "muse.attunegraph.shadow-timing-projection.v1",
  "muse.attunegraph.shadow-decision-receipt.v1",
  "muse.attunegraph.shadow-decision:",
  "muse.attunegraph.fair-frontier-bundle-order-admission.v1",
  "muse.attunegraph.fair-frontier-bundle-order-request.v1",
  "muse.attunegraph.fair-frontier-bundle-order.v1",
  "muse.attunegraph.fair-witness-frontier-receipt.v1",
  "muse.attunegraph.provider-bound-graph-evidence-receipt.v1",
  "muse.attunegraph.provider-bound-omitted-assertion-ids.v1",
  "muse.attunegraph.provider-head-revalidated-graph-evidence-receipt.v1",
  "muse.attunegraph.receipt-bound-activation-evidence.v1",
  "muse.attunegraph.receipt-bound-graph-evidence-admission.v1",
  "muse.attunegraph.receipt-bound-graph-evidence-receipt.v1",
  "muse.attunegraph.scoped-proof-document-settlement-request.v1",
  "muse.attunegraph.scoped-proof-document.v1",
  "muse.attunegraph.thread-rooted-retained-witness-entry.v1",
  "muse.attunegraph.thread-rooted-retained-witness-fair-order.v1",
  "muse.attunegraph.thread-rooted-retained-witness-focus-assertion.v1",
  "muse.attunegraph.thread-rooted-retained-witness-frontier-dispositions.v1",
  "muse.attunegraph.thread-rooted-retained-witness-manifest.v1",
  "muse.attunegraph.thread-rooted-retained-witness-thread-dispositions.v1",
  "muse.attunegraph.thread-rooted-witness-admission.v1",
  "muse.attunegraph.thread-rooted-witness-receipt.v1",
  "muse.attunegraph.thread-rooted-witness-request.v1",
  "muse-attunegraph-fair-frontier-admission:",
  "muse-attunegraph-fair-frontier-admission:sha256:",
  "muse-attunegraph-fair-frontier-order:sha256:",
  "muse-attunegraph-fair-frontier-request:",
  "muse-attunegraph-fair-frontier-request:sha256:",
  "muse-attunegraph-fair-witness-frontier-receipt:sha256:",
  "muse-attunegraph-provider-bound-graph-evidence:sha256:",
  "muse-attunegraph-provider-bound-omitted-assertion-ids:sha256:",
  "muse-attunegraph-provider-head-revalidated-graph-evidence:sha256:",
  "muse-attunegraph-receipt-bound-activation-evidence:sha256:",
  "muse-attunegraph-receipt-bound-graph-admission:sha256:",
  "muse-attunegraph-receipt-bound-graph-evidence-receipt:sha256:",
  "muse-attunegraph-scoped-proof-document:sha256:",
  "muse-attunegraph-scoped-proof-request:sha256:",
  "muse-attunegraph-thread-rooted-retained-witness-entry:sha256:",
  "muse-attunegraph-thread-rooted-retained-witness-manifest:sha256:",
  "muse-attunegraph-thread-rooted-witness-admission:sha256:",
  "muse-attunegraph-thread-rooted-witness-receipt:sha256:",
  "muse-attunegraph-thread-rooted-witness-request:sha256:",
  "muse-attunegraph-provider-graph-",
  "muse-attunegraph-provider-graph-verifier-"
];

const allowedRoots = [
  "packages/attunegraph/", "packages/muse-attunegraph/", `packages/${["attunement", "graph"].join("-")}/`,
  "docs/", "internal/goals/", "scripts/check-attunegraph-naming.mjs",
  "scripts/check-attunegraph-naming.test.mjs", "scripts/check-attunegraph-boundary.test.mjs",
  "scripts/run-attunegraph-rename-verification.mjs", "scripts/write-attunegraph-rename-evidence.mjs",
  "scripts/verify-attunegraph-rename-evidence.mjs", "scripts/attunegraph-rename-evidence.test.mjs",
  "scripts/check-doc-links.mjs", "scripts/check-doc-claims.mjs", "scripts/check-doc-sections.mjs",
  "scripts/env-inventory.mjs", "scripts/env-inventory.test.mjs",
  "packages/attunement/README.md", "packages/attunement/package.json",
  "packages/attunement/src/index.ts", "packages/attunement/src/testing.ts",
  "packages/attunement/src/timing-store.ts", "packages/attunement/src/timing-store.test.ts",
  "packages/autoconfigure/README.md", "packages/autoconfigure/package.json",
  "packages/autoconfigure/src/continuity-learning-apply-tool.ts",
  "packages/autoconfigure/src/continuity-learning-preview-tool.ts",
  "packages/autoconfigure/src/continuity-learning-replay-preview-tool.ts",
  "packages/autoconfigure/src/continuity-learning-rollback-tool.ts",
  "packages/autoconfigure/src/continuity-pack-tools.ts",
  "packages/autoconfigure/src/loopback-tools.ts",
  "packages/autoconfigure/src/trigger-lineage-execution-adapter.ts",
  "packages/autoconfigure/test/continuity-pack-tools.test.ts",
  "packages/autoconfigure/test/trigger-lineage-execution-adapter.test.ts",
  "packages/autoconfigure/tsconfig.json",
  "AGENTS.md", "CHANGELOG.md", "CLAUDE.md", "CONTEXT.md", "README.md",
  "package.json", "pnpm-lock.yaml", "tsconfig.json"
];

const git = (args, cwd = process.cwd(), encoding = "utf8") => execFileSync("git", args, { cwd, encoding });
const parseArgs = (argv) => Object.fromEntries(argv.slice(2).reduce((pairs, value, index, values) => value.startsWith("--") ? [...pairs, [value.slice(2), values[index + 1]]] : pairs, []));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function assertReceipts(receipts, commits) {
  const matrix = materializeCommandMatrix(commits);
  if (!Array.isArray(receipts) || receipts.length !== matrix.length) throw new Error("receipt matrix is incomplete");
  for (const [index, [name, argv]] of matrix.entries()) {
    const receipt = receipts[index];
    if (!receipt || receipt.sequence !== index || receipt.name !== name || JSON.stringify(receipt.argv) !== JSON.stringify(argv)) throw new Error(`receipt ${index} is missing, duplicated, or reordered`);
    const expectsTests = name.includes("test");
    if (receipt.exitCode !== 0 || !receipt.testCounts || receipt.testCounts.failed !== 0 || !Number.isInteger(receipt.testCounts.passed) || (expectsTests && receipt.testCounts.passed < 1)) throw new Error(`receipt ${name} is not green`);
  }
}

export function assertReceiptDocument(receiptDocument, commits) {
  if (!receiptDocument
    || receiptDocument.version !== 1
    || receiptDocument.baseline !== commits.baseline
    || receiptDocument.candidate !== commits.candidate) {
    throw new Error("receipt document commit binding is invalid");
  }
  assertReceipts(receiptDocument.receipts, commits);
  return receiptDocument.receipts;
}

export function assertAllowedDiffPaths(paths) {
  for (const path of paths) {
    if (!allowedRoots.some((allowed) => path === allowed || path.startsWith(allowed))) throw new Error(`unexpected rename diff path: ${path}`);
  }
}

export function committedHashes(candidate, cwd = process.cwd()) {
  const paths = git(["ls-tree", "-r", "--name-only", candidate], cwd).trim().split("\n").filter((path) =>
    path.startsWith("packages/attunegraph/fixtures/") || path.startsWith("packages/attunegraph/src/fixtures/") ||
    path === "packages/attunegraph/attunegraph-local-runtime-manifest.json" || path.startsWith("scripts/check-attunegraph-") ||
    path === "scripts/run-attunegraph-rename-verification.mjs" || path === "scripts/write-attunegraph-rename-evidence.mjs" ||
    path === "scripts/verify-attunegraph-rename-evidence.mjs" || path === "scripts/attunegraph-rename-evidence.test.mjs"
  ).sort();
  if (paths.length === 0) throw new Error("committed fixture/check inputs are missing");
  return paths.map((path) => ({ path, sha256: hash(git(["show", `${candidate}:${path}`], cwd, "buffer")) }));
}

export function buildEvidence({ baseline, candidate, receiptDocument, cwd = process.cwd() }) {
  const commits = assertCandidate({ baseline, candidate, cwd });
  const receipts = assertReceiptDocument(receiptDocument, commits);
  const diffPaths = git(["diff", "--name-only", `${commits.baseline}...${commits.candidate}`], cwd).trim().split("\n").filter(Boolean).sort();
  assertAllowedDiffPaths(diffPaths);
  return { version: 1, ...commits, receipts, identities: canonicalIdentities, hashes: committedHashes(commits.candidate, cwd), diffPaths };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv);
    if (!args.baseline || !args.candidate || !args.receipts || !args.out) throw new Error("--baseline, --candidate, --receipts, and --out are required");
    const receiptDocument = JSON.parse(readFileSync(args.receipts, "utf8"));
    const evidence = buildEvidence({
      baseline: args.baseline,
      candidate: args.candidate,
      receiptDocument
    });
    writeFileSync(args.out, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

export { canonicalIdentities, allowedRoots };
