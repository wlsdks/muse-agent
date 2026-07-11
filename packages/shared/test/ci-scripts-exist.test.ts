import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// A CI step calling a pnpm script that package.json doesn't define fails
// every push at runtime but nothing catches it at commit time (the
// lint:comments step shipped without its script and main CI stayed red for
// nine days). This locks the workflow → package.json contract.
const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");

describe("workflow pnpm scripts exist", () => {
  it("every `pnpm <script>` a workflow runs is defined in the root package.json", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      readonly scripts: Readonly<Record<string, string>>;
    };
    const workflowsDir = join(repoRoot, ".github", "workflows");
    const missing: string[] = [];
    for (const file of readdirSync(workflowsDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))) {
      const body = readFileSync(join(workflowsDir, file), "utf8");
      // Match bare `pnpm <script>` run lines; `pnpm --filter`/`pnpm -r` forms
      // target workspace packages and are out of this contract's scope.
      for (const match of body.matchAll(/run:\s+pnpm\s+([a-z][a-z0-9:_-]*)/g)) {
        const script = match[1]!;
        if (script === "install") continue;
        if (!(script in pkg.scripts)) {
          missing.push(`${file}: pnpm ${script}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
