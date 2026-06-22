import { describe, expect, it } from "vitest";

import { NotesProviderRegistry, TasksProviderRegistry } from "../src/index.js";
import type { NotesProvider } from "@muse/domain-tools";
import { isPrimarySentinel } from "@muse/mcp";
import type { TasksProvider } from "@muse/domain-tools";

// Coverage for the hallucinated-sentinel routing (untested). The local Qwen,
// having no live provider list, invents a routing id like "default"/"primary"
// when a create tool asks for one (tool-calling.md). isPrimarySentinel + the
// registries' requireOrPrimary must resolve those (and blank/undefined) to the
// PRIMARY provider so a valid write doesn't fail on a hallucinated field —
// while a concrete UNKNOWN id still errors rather than silently writing to the
// wrong store.

const tasksProvider = (id: string): TasksProvider => ({
  createTask: async () => ({}), deleteTask: async () => undefined, describe: () => ({ id }),
  id, listTasks: async () => [], updateTask: async () => ({})
}) as unknown as TasksProvider;

const notesProvider = (id: string): NotesProvider => ({
  create: async () => ({}), describe: () => ({ id }), id, list: async () => [], read: async () => undefined, search: async () => []
}) as unknown as NotesProvider;

describe("isPrimarySentinel", () => {
  it("matches default/primary case- and whitespace-insensitively", () => {
    expect(isPrimarySentinel("default")).toBe(true);
    expect(isPrimarySentinel("PRIMARY")).toBe(true);
    expect(isPrimarySentinel("  Default  ")).toBe(true);
  });

  it("is false for a concrete provider id and for blank/whitespace (the latter is handled separately as 'use primary')", () => {
    expect(isPrimarySentinel("notion")).toBe(false);
    expect(isPrimarySentinel("")).toBe(false);
    expect(isPrimarySentinel("   ")).toBe(false);
  });
});

describe("TasksProviderRegistry.requireOrPrimary", () => {
  it("routes a sentinel / blank / undefined id to the PRIMARY provider", () => {
    const registry = new TasksProviderRegistry([tasksProvider("local"), tasksProvider("notion")]);
    for (const id of ["default", "PRIMARY", "  ", undefined] as const) {
      expect(registry.requireOrPrimary(id).id).toBe("local"); // primary = first registered
    }
  });

  it("routes a concrete known id to that provider but errors on a concrete unknown id", () => {
    const registry = new TasksProviderRegistry([tasksProvider("local"), tasksProvider("notion")]);
    expect(registry.requireOrPrimary("notion").id).toBe("notion");
    expect(() => registry.requireOrPrimary("nope")).toThrow();
    try {
      registry.requireOrPrimary("nope");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("PROVIDER_NOT_FOUND");
    }
  });

  it("throws NO_PROVIDERS when nothing is registered", () => {
    try {
      new TasksProviderRegistry([]).requireOrPrimary("default");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("NO_PROVIDERS");
    }
  });
});

describe("NotesProviderRegistry.requireOrPrimary", () => {
  it("routes a sentinel to the primary and a concrete id to that provider, erroring on an unknown id", () => {
    const registry = new NotesProviderRegistry([notesProvider("local"), notesProvider("obsidian")]);
    expect(registry.requireOrPrimary("default").id).toBe("local");
    expect(registry.requireOrPrimary("obsidian").id).toBe("obsidian");
    try {
      registry.requireOrPrimary("nope");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("PROVIDER_NOT_FOUND");
    }
  });
});
