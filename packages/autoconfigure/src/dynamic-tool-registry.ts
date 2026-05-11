/**
 * `DynamicToolRegistry` — a small `ToolRegistry` subclass that merges
 * statically-registered tools with lazy "source" functions that may
 * return different tool sets over time (e.g., loopback MCP servers
 * that gain or lose tools as the messaging registry's provider list
 * changes).
 *
 * Extracted from `index.ts` to keep that file focused on the runtime
 * + API-options assembly factories; this class has no env-driven
 * configuration logic of its own.
 */

import { ToolRegistry, type MuseTool } from "@muse/tools";

export class DynamicToolRegistry extends ToolRegistry {
  constructor(private readonly sources: readonly (() => readonly MuseTool[])[]) {
    super();
  }

  override get(name: string): MuseTool | undefined {
    return super.get(name) ?? this.dynamicTools().find((tool) => tool.definition.name === name);
  }

  override list(): readonly MuseTool[] {
    return [...super.list(), ...this.dynamicTools()];
  }

  private dynamicTools(): readonly MuseTool[] {
    const byName = new Map<string, MuseTool>();

    for (const source of this.sources) {
      for (const tool of source()) {
        byName.set(tool.definition.name, tool);
      }
    }

    return [...byName.values()];
  }
}
