import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const cliSrc = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(cliSrc, "../../..");
const PURE_FILES = [
  join(cliSrc, "daemon-workload-governor.ts"),
  join(cliSrc, "daemon-resource-admission.ts"),
  join(cliSrc, "daemon-resource-receipt.ts"),
  join(cliSrc, "daemon-resource-status.ts"),
  join(repoRoot, "packages/macos/src/system-resource-observation.ts")
];
const ALLOWED_EXTERNAL = new Set([
  "@muse/macos/system-resource-observation",
  "@muse/stores/atomic-file-store"
]);

function importSpecifiers(source: string): readonly string[] {
  return [...source.matchAll(/^\s*(?:(?:import|export)\b[^\n]*?\bfrom\s+|import\s*\()(["'])(?<specifier>[^"']+)\1/gmu)]
    .map((match) => match.groups?.specifier)
    .filter((value): value is string => value !== undefined);
}

describe("daemon workload pure dependency boundary", () => {
  it("loads no model, provider, browser, messaging, email, prompt, content-store, or broad package barrel", () => {
    const violations: string[] = [];
    for (const file of PURE_FILES) {
      const source = readFileSync(file, "utf8");
      for (const specifier of importSpecifiers(source)) {
        if (specifier.startsWith("node:") || specifier.startsWith("./") || ALLOWED_EXTERNAL.has(specifier)) continue;
        violations.push(`${file}: ${specifier}`);
      }
      expect(source).not.toMatch(/\b(?:require|eval)\s*\(/u);
    }
    expect(violations).toEqual([]);
  });
});
