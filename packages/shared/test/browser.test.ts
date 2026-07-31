import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DELIVERY_SAFETY_SCHEMA_VERSION,
  errorMessage,
  isDeliverySafetyResult,
  isRecord,
  parseJson,
  parseJsonWith
} from "../src/browser.js";

const SOURCE_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

async function findNodeImports(entryPath: string): Promise<string[]> {
  const pending = [entryPath];
  const visited = new Set<string>();
  const nodeImports: string[] = [];
  const importPattern =
    /(?:^|\n)\s*(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']\s*;?/g;

  while (pending.length > 0) {
    const sourcePath = pending.pop();
    if (sourcePath === undefined || visited.has(sourcePath)) continue;
    visited.add(sourcePath);

    const source = await readFile(sourcePath, "utf8");
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      if (specifier.startsWith("node:")) {
        nodeImports.push(`${sourcePath}: ${specifier}`);
        continue;
      }
      if (!specifier.startsWith(".")) continue;
      pending.push(resolve(dirname(sourcePath), specifier.replace(/\.js$/, ".ts")));
    }
  }

  return nodeImports;
}

describe("browser shared entry point", () => {
  it("keeps its complete source import graph free of Node builtins", async () => {
    await expect(findNodeImports(resolve(SOURCE_DIRECTORY, "browser.ts"))).resolves.toEqual([]);
  });

  it("exports the JSON parsing and record guards used by browser streams", () => {
    const parsed = parseJson('{"answer":"ready"}');
    expect(parsed).toEqual({ answer: "ready" });
    expect(parseJson("not json")).toBeUndefined();
    expect(parseJsonWith('{"answer":"ready"}', isRecord)).toEqual({ answer: "ready" });
    expect(parseJsonWith("[]", isRecord)).toBeUndefined();
  });

  it("exports the delivery-safety contract without a Node-only entrypoint", () => {
    expect(DELIVERY_SAFETY_SCHEMA_VERSION).toBe(1);
    expect(typeof isDeliverySafetyResult).toBe("function");
  });

  it("normalizes Error, error-like, and fallback messages without Node APIs", () => {
    expect(errorMessage(new Error("network failed"))).toBe("network failed");
    expect(errorMessage({ message: "request failed" })).toBe("request failed");
    expect(errorMessage(undefined, "Request failed.")).toBe("Request failed.");
  });
});
