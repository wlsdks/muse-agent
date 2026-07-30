import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { assertCandidate } from "./run-attunegraph-rename-verification.mjs";
import { assertAllowedDiffPaths, assertReceipts, canonicalIdentities, committedHashes } from "./write-attunegraph-rename-evidence.mjs";
import { scanAttuneGraphNaming } from "./check-attunegraph-naming.mjs";

const git = (args, cwd = process.cwd(), encoding = "utf8") => execFileSync("git", args, { cwd, encoding });
const parseArgs = (argv) => Object.fromEntries(argv.slice(2).reduce((pairs, value, index, values) => value.startsWith("--") ? [...pairs, [value.slice(2), values[index + 1]]] : pairs, []));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
function assertNoSupersededCandidateIdentity(candidate, cwd) {
  const paths = git(["ls-tree", "-r", "--name-only", candidate], cwd)
    .split("\n")
    .filter(Boolean);
  const findings = scanAttuneGraphNaming({
    cwd,
    paths,
    read: (absolutePath) => {
      const prefix = `${cwd}/`;
      const path = absolutePath.startsWith(prefix) ? absolutePath.slice(prefix.length) : absolutePath;
      return git(["show", `${candidate}:${path}`], cwd, "buffer");
    }
  });
  if (findings.length > 0) throw new Error("candidate contains a superseded identity");
}

function assertCanonicalIdentitiesPresent(candidate, cwd) {
  const candidatePaths = git(["ls-tree", "-r", "--name-only", candidate], cwd)
    .split("\n")
    .filter(Boolean);
  for (const identity of canonicalIdentities) {
    try {
      git(
        ["grep", "-I", "-F", "-e", identity, candidate, "--", "packages", "docs", "internal", "AGENTS.md", "README.md", "CONTEXT.md"],
        cwd
      );
    } catch (error) {
      if (error.status === 1 && candidatePaths.some((path) => path.includes(identity))) continue;
      if (error.status === 1) throw new Error(`candidate is missing canonical identity: ${identity}`);
      throw error;
    }
  }
}

export function verifyEvidence(evidence, { baseline, candidate, cwd = process.cwd() } = {}) {
  const commits = assertCandidate({ baseline, candidate, cwd });
  if (!evidence || evidence.version !== 1 || evidence.baseline !== commits.baseline || evidence.candidate !== commits.candidate) throw new Error("evidence commit binding is invalid");
  assertReceipts(evidence.receipts, commits);
  if (!same(evidence.identities, canonicalIdentities)) throw new Error("evidence identities are incomplete or tampered");
  assertNoSupersededCandidateIdentity(commits.candidate, cwd);
  assertCanonicalIdentitiesPresent(commits.candidate, cwd);
  const actualDiffPaths = git(["diff", "--name-only", `${commits.baseline}...${commits.candidate}`], cwd).trim().split("\n").filter(Boolean).sort();
  assertAllowedDiffPaths(actualDiffPaths);
  if (!same(evidence.diffPaths, actualDiffPaths)) throw new Error("evidence diff paths are stale or tampered");
  if (!same(evidence.hashes, committedHashes(commits.candidate, cwd))) throw new Error("evidence committed-blob hashes are stale or tampered");
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv);
    if (!args.evidence || !args.baseline || !args.candidate) throw new Error("--evidence, --baseline, and --candidate are required");
    verifyEvidence(JSON.parse(readFileSync(args.evidence, "utf8")), args);
    process.stdout.write("AttuneGraph rename evidence verified.\n");
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
