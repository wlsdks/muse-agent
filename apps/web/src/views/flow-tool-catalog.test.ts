import { describe, expect, it } from "vitest";

import { isWriteToolSelection, schedulableToolOptions, toolsForServer, uniqueServerNames } from "./flow-tool-catalog.js";

import type { LoopbackCatalogResponse } from "../api/types.js";

const CATALOG: LoopbackCatalogResponse = {
  servers: [
    {
      description: "Built-in clock and date utilities (loopback MCP).",
      name: "muse.time",
      optIn: false,
      tools: [
        { description: "Returns the current ISO timestamp.", name: "now", risk: "read" },
        { description: "Duration in ms between two ISO timestamps.", name: "diff_ms", risk: "read" }
      ]
    },
    {
      description: "Contacts store.",
      name: "muse.contacts",
      optIn: false,
      tools: [
        { description: "Look up a contact.", name: "find", risk: "read" },
        { description: "Create a contact.", name: "create", risk: "write" }
      ]
    },
    {
      description: "Filesystem access.",
      name: "muse.fs",
      optIn: true,
      tools: [
        { description: "Delete a file.", name: "delete", risk: "execute" },
        { description: "A tool with no declared risk.", name: "mystery" }
      ]
    }
  ],
  total: 3
};

describe("schedulableToolOptions — the read+write picker filter (진안 2026-07-18 ruling)", () => {
  it("keeps read AND write tools with their risk, dropping execute AND unrisked tools", () => {
    const options = schedulableToolOptions(CATALOG);
    expect(options).toEqual([
      { risk: "read", serverDescription: "Built-in clock and date utilities (loopback MCP).", serverName: "muse.time", toolDescription: "Returns the current ISO timestamp.", toolName: "now" },
      { risk: "read", serverDescription: "Built-in clock and date utilities (loopback MCP).", serverName: "muse.time", toolDescription: "Duration in ms between two ISO timestamps.", toolName: "diff_ms" },
      { risk: "read", serverDescription: "Contacts store.", serverName: "muse.contacts", toolDescription: "Look up a contact.", toolName: "find" },
      { risk: "write", serverDescription: "Contacts store.", serverName: "muse.contacts", toolDescription: "Create a contact.", toolName: "create" }
    ]);
  });

  it("MUTATION-RED: execute-class and undeclared-risk tools must never be schedulable", () => {
    const options = schedulableToolOptions(CATALOG);
    expect(options.some((option) => option.toolName === "delete")).toBe(false);
    expect(options.some((option) => option.toolName === "mystery")).toBe(false);
  });

  it("an empty catalog yields an empty option list", () => {
    expect(schedulableToolOptions({ servers: [], total: 0 })).toEqual([]);
  });
});

describe("isWriteToolSelection — drives the one-time state-change confirmation", () => {
  it("true only for the write pair, false for read pairs and unknown pairs", () => {
    const options = schedulableToolOptions(CATALOG);
    expect(isWriteToolSelection(options, "muse.contacts", "create")).toBe(true);
    expect(isWriteToolSelection(options, "muse.contacts", "find")).toBe(false);
    expect(isWriteToolSelection(options, "muse.time", "now")).toBe(false);
    expect(isWriteToolSelection(options, "muse.fs", "delete")).toBe(false);
    expect(isWriteToolSelection(options, "", "")).toBe(false);
  });
});

describe("uniqueServerNames / toolsForServer — cascading select derivation", () => {
  it("uniqueServerNames returns each server exactly once, in first-seen order", () => {
    const options = schedulableToolOptions(CATALOG);
    expect(uniqueServerNames(options)).toEqual(["muse.time", "muse.contacts"]);
  });

  it("toolsForServer scopes to the chosen server's schedulable tools", () => {
    const options = schedulableToolOptions(CATALOG);
    expect(toolsForServer(options, "muse.time").map((tool) => tool.toolName)).toEqual(["now", "diff_ms"]);
    expect(toolsForServer(options, "muse.contacts").map((tool) => tool.toolName)).toEqual(["find", "create"]);
  });

  it("toolsForServer returns an empty list for a server with no schedulable tools", () => {
    const options = schedulableToolOptions(CATALOG);
    expect(toolsForServer(options, "muse.fs")).toEqual([]);
  });
});

describe("outbound write exclusion (outbound-safety floor)", () => {
  it("a write tool on muse.messaging is NEVER schedulable, while other write tools are", () => {
    const catalog: LoopbackCatalogResponse = {
      servers: [
        {
          description: "Messaging.",
          name: "muse.messaging",
          optIn: false,
          tools: [{ description: "Send a message.", name: "send", risk: "write" }]
        },
        {
          description: "Reminders.",
          name: "muse.reminders",
          optIn: false,
          tools: [{ description: "Add a reminder.", name: "add", risk: "write" }]
        }
      ],
      total: 2
    };
    const options = schedulableToolOptions(catalog);
    expect(options.some((option) => option.serverName === "muse.messaging")).toBe(false);
    expect(options.some((option) => option.serverName === "muse.reminders" && option.toolName === "add")).toBe(true);
  });
});
