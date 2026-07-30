import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { TextDecoder } from "node:util";

const word = (...parts) => parts.join("");
const short = word("m", "ag");
const long = word("Attunement", "Graph");
const oldPackage = word("@muse/", "attunement-", "graph");
const oldPath = word("packages/", "attunement-", "graph");
const oldFormat = word("muse-", short, "-portable");
const oldExtension = word(".", short, "x");
const museIntegrationPackage = word("@muse/", "attunegraph");
const coreOnlySubpaths = ["backend", "extension-kit", "local", "testing"];

const patterns = [
  ["old package", new RegExp(escape(oldPackage), "i")],
  ["old path", new RegExp(escape(oldPath), "i")],
  ["old long product identity", new RegExp(escape(long), "i")],
  ["old portable format", new RegExp(escape(oldFormat), "i")],
  ["old portable extension", new RegExp(escape(oldExtension), "i")],
  ["superseded acronym identity", new RegExp(`(^|[^A-Za-z0-9])(?:${short.toUpperCase()}s?|${short}|${short[0].toUpperCase()}${short.slice(1)}(?:[A-Z][A-Za-z0-9]*|\\*)?|${short}[A-Z][A-Za-z0-9]*|${short}(?:[_-][A-Za-z0-9]+|\\.[A-Za-z0-9]+))(?=$|[^A-Za-z0-9])|[a-z0-9]${short[0].toUpperCase()}${short.slice(1)}(?:[A-Z][A-Za-z0-9]*)?(?=$|[^A-Za-z0-9])`)],
  ["old dotted graph namespace", new RegExp(`muse\\.${short}|muse\\.${word("attunement", "-graph")}|${short}[-.]local|${short}[-.]admin|${short}[-.]portable`, "i")],
  ["core-only subpath on Muse integration", new RegExp(`${escape(museIntegrationPackage)}/(?:${coreOnlySubpaths.join("|")})(?=$|[^A-Za-z0-9._-])`)]
];

function escape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function gitPaths(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "buffer" })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

export function trackedAndUntrackedPaths(cwd = process.cwd()) {
  return [...new Set([
    ...gitPaths(["ls-files", "-z"], cwd),
    ...gitPaths(["ls-files", "--others", "--exclude-standard", "-z"], cwd)
  ])].sort();
}

export function scanAttuneGraphNaming({ cwd = process.cwd(), paths = trackedAndUntrackedPaths(cwd), read = readFileSync } = {}) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const findings = [];
  for (const path of paths) {
    const fullPath = `${cwd}/${path}`;
    if (read === readFileSync && !existsSync(fullPath)) continue; // an in-progress rename may have index-only deletions.
    for (const [family, expression] of patterns) {
      if (expression.test(path)) findings.push({ path, where: "path", family });
    }
    let content;
    try {
      const bytes = read(fullPath);
      if (Buffer.isBuffer(bytes) && bytes.includes(0)) continue;
      content = decoder.decode(bytes);
    } catch {
      continue; // binary and non-UTF-8 inputs are deliberately outside the text-name audit.
    }
    for (const [family, expression] of patterns) {
      if (expression.test(content)) findings.push({ path, where: "content", family });
    }
  }
  return findings;
}

export function assertCanonicalNaming(options) {
  const findings = scanAttuneGraphNaming(options);
  if (findings.length > 0) {
    throw new Error(`Superseded AttuneGraph naming found:\n${findings.map((finding) => `${finding.path} (${finding.where}: ${finding.family})`).join("\n")}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    assertCanonicalNaming();
    process.stdout.write("AttuneGraph naming check passed.\n");
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
