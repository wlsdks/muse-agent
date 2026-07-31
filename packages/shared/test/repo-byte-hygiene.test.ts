import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// goal-227: committed source AND docs must not carry raw control /
// zero-width / BOM bytes — adversarial inputs use escape notation
// or String.fromCharCode. This test is the enforcement the rule
// always described as a "pre-commit scan" but was never wired to;
// it fails `pnpm check` on any regression. Detection is a
// code-point predicate (no raw bytes, no misleading regex class)
// so this file is itself clean.
function hasForbiddenCodePoint(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (
      c <= 0x08 ||
      (c >= 0x0b && c <= 0x1f) ||
      c === 0x7f ||
      c === 0x200b ||
      c === 0x200c ||
      c === 0x200d ||
      c === 0xfeff
    ) {
      return true;
    }
  }
  return false;
}

const SCANNED_EXTENSIONS = new Set([
  "ts", "tsx", "js", "mjs", "cjs", "md", "json", "rs"
]);

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");

function trackedTextFiles(): readonly string[] {
  const out = execFileSync("git", ["-C", repoRoot, "ls-files", "--recurse-submodules"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
  return out
    .split("\n")
    .filter((line) => line.length > 0)
    .filter((path) => {
      const dot = path.lastIndexOf(".");
      return dot >= 0 && SCANNED_EXTENSIONS.has(path.slice(dot + 1));
    });
}

describe("repo byte hygiene (goal-227)", () => {
  it("no tracked source/doc file carries a raw control / zero-width / BOM byte", () => {
    const files = trackedTextFiles();
    // Guard against a silent false-pass: a wrong repoRoot / empty
    // `git ls-files` would scan nothing and "pass" vacuously.
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain("packages/attunegraph/src/index.ts");
    const offenders: string[] = [];
    for (const rel of files) {
      let content: string;
      try {
        content = readFileSync(join(repoRoot, rel), "utf8");
      } catch {
        continue;
      }
      if (!hasForbiddenCodePoint(content)) continue;
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        if (hasForbiddenCodePoint(lines[i]!)) {
          offenders.push(`${rel}:${(i + 1).toString()}`);
        }
      }
    }
    expect(
      offenders,
      `Raw forbidden bytes (goal-227) found — use \\xNN / String.fromCharCode / U+NNNN notation instead:\n${offenders.join("\n")}`
    ).toEqual([]);
  });
});
