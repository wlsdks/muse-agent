import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Regression lock: `node:child_process/promises` does not exist in ANY
 * Node release (unlike fs/promises, timers/promises, dns/promises,
 * stream/promises, readline/promises). An import of it compiles in
 * editors that trust stale typings but crashes `tsc -b` and runtime —
 * it broke main twice in one day (0f3049154, 453291980). The promise
 * form is `promisify(execFile)` from node:util.
 */
const PHANTOM_MODULES = ["node:child_process/promises", "node:os/promises"] as const;

const srcDir = join(fileURLToPath(new URL(".", import.meta.url)));

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(full);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
  });
}

describe("no phantom node: module imports", () => {
  it("no source file imports a node: submodule that does not exist", () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(srcDir)) {
      const content = readFileSync(file, "utf8");
      for (const phantom of PHANTOM_MODULES) {
        if (content.includes(`"${phantom}"`) || content.includes(`'${phantom}'`)) {
          offenders.push(`${file} imports ${phantom}`);
        }
      }
    }
    expect(offenders, `phantom node: imports found — use promisify() from node:util instead:\n${offenders.join("\n")}`).toEqual([]);
  });
});
