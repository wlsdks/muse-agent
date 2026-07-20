/**
 * Schema quality across EVERY registered tool, not one at a time.
 *
 * `tool-calling.md` rule 3 exists because "invalid arguments" is the second
 * biggest tool-calling failure mode on a small local model, and it is fixed in
 * the schema rather than the prompt. A repo-wide audit found the same two
 * defects in a dozen places — a parameter the model must fill with no
 * description at all, and a fixed value set described only in prose — so this
 * asserts the property over the whole registry instead of per tool.
 *
 * The allowlists are deliberately explicit: a new entry is a decision someone
 * has to write down, not something that accumulates silently.
 */

import { describe, expect, it } from "vitest";

import { createMuseRuntimeAssembly } from "@muse/autoconfigure";
import type { MuseTool } from "@muse/tools";

interface Property {
  readonly description?: string;
  readonly enum?: readonly unknown[];
  readonly type?: unknown;
}

function registeredTools(): readonly MuseTool[] {
  const registry = createMuseRuntimeAssembly({ env: { ...process.env } }).toolRegistry;
  return registry.list();
}

function propertiesOf(tool: MuseTool): readonly [string, Property][] {
  const schema = tool.definition.inputSchema as { properties?: Record<string, Property> } | undefined;
  return Object.entries(schema?.properties ?? {});
}

describe("every registered tool has a schema a small model can fill", () => {
  it("registers a meaningful number of tools (guards against an empty sweep)", () => {
    // A test that silently audits zero tools passes forever. Pin the floor.
    expect(registeredTools().length).toBeGreaterThan(50);
  });

  it("gives every parameter a description", () => {
    const missing: string[] = [];
    for (const tool of registeredTools()) {
      for (const [name, property] of propertiesOf(tool)) {
        if (!property.description || property.description.trim().length === 0) {
          missing.push(`${tool.definition.name}.${name}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("gives every parameter a declared type", () => {
    const untyped: string[] = [];
    for (const tool of registeredTools()) {
      for (const [name, property] of propertiesOf(tool)) {
        if (property.type === undefined && !Array.isArray(property.enum)) {
          untyped.push(`${tool.definition.name}.${name}`);
        }
      }
    }
    expect(untyped).toEqual([]);
  });
});
