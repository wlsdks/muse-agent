import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as hostSurface from "./host.js";
import * as publicSurface from "./index.js";

const organicProducerNames = [
  "createOrganicContinuityWriteAuthority",
  "openProductionAuthorizedContinuityPack",
  "prepareProductionAuthorizedContinuityTaskCompletionInteraction",
  "recordProductionAuthorizedContinuityOutcome"
] as const;
type OrganicProducerName = (typeof organicProducerNames)[number];
type MainOrganicProducersAreAbsent = Extract<OrganicProducerName, keyof typeof publicSurface> extends never ? true : false;
const mainOrganicProducersAreAbsent: MainOrganicProducersAreAbsent = true;

const root = fileURLToPath(new URL("../../../", import.meta.url));
const hostSpecifier = "@muse/attunement" + "/host";
const hostImportPattern = new RegExp(`(?:\\bfrom\\s*|\\bimport\\s*(?:\\(\\s*)?|\\brequire\\s*\\(\\s*)["']${hostSpecifier}["']`, "u");
const allowedHostImports = [
  "apps/api/src/attunement-routes.ts",
  "apps/api/src/tasks-routes.ts",
  "apps/cli/src/commands-attunement.ts",
  "apps/cli/src/commands-tasks.ts",
  "packages/autoconfigure/src/loopback-tools.ts"
];
const generatedDirectories = new Set([
  ".codegraph",
  ".git",
  ".muse-dev",
  ".next",
  ".turbo",
  ".vite",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "target",
  "test-results"
]);

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry): Promise<string[]> => {
    const file = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (generatedDirectories.has(entry.name) || file === resolve(root, ".claude", "worktrees")) return [];
      return sourceFiles(file);
    }
    return /\.(?:[cm]?[jt]sx?)$/u.test(entry.name) ? [file] : [];
  }))).flat();
}

describe("@muse/attunement public authority surface", () => {
  it("does not expose a reusable organic-authority mint at runtime", () => {
    expect(mainOrganicProducersAreAbsent).toBe(true);
    for (const name of organicProducerNames) expect(name in publicSurface).toBe(false);
    expect(Object.keys(hostSurface).sort()).toEqual([
      "openProductionAuthorizedContinuityPack",
      "prepareProductionAuthorizedContinuityTaskCompletionInteraction",
      "recordProductionAuthorizedContinuityOutcome"
    ]);
  });

  it("allowlists the explicit host seam to production composition roots", async () => {
    const files = await sourceFiles(root);
    const imports = (await Promise.all(files.map(async (file) => hostImportPattern.test(await readFile(file, "utf8"))
      ? relative(root, file)
      : undefined))).filter((file): file is string => file !== undefined).sort();
    expect(imports).toEqual(allowedHostImports);
  });
});
