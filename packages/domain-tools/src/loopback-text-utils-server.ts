import type { JsonObject } from "@muse/shared";

import { readString } from "@muse/mcp";
import type { LoopbackMcpServer } from "@muse/mcp";

/**
 * `muse.text` text-stat utilities — character/line/word count and
 * string reverse. Pure, no IO. Lifted out of `loopback.ts`.
 */

export function createTextUtilsMcpServer(): LoopbackMcpServer {
  return {
    description: "Built-in text utilities (loopback MCP).",
    name: "muse.text",
    tools: [
      {
        description: "Returns word, character, and line counts for the input text.",
        execute: (args): JsonObject => {
          const text = readString(args, "text") ?? "";
          if (text.trim().length === 0) {
            return { characters: 0, lines: 0, words: 0 } satisfies JsonObject;
          }
          const words = text.trim().split(/\s+/u).filter((segment) => segment.length > 0).length;
          const lines = text.split(/\r?\n/u).length;
          // Count Unicode code points, not UTF-16 units, so an astral
          // char (emoji) is one character — consistent with #reverse,
          // which iterates `[...text]` code-point-aware.
          const characters = [...text].length;
          return { characters, lines, words } satisfies JsonObject;
        },
        inputSchema: {
          additionalProperties: false,
          properties: { text: { type: "string" } },
          required: ["text"],
          type: "object"
        },
        name: "stats",
        risk: "read"
      },
      {
        description: "Reverses the input text. Useful for unit tests and sanity checks.",
        execute: (args): JsonObject => {
          const text = readString(args, "text") ?? "";
          return { reversed: [...text].reverse().join("") } satisfies JsonObject;
        },
        inputSchema: {
          additionalProperties: false,
          properties: { text: { type: "string" } },
          required: ["text"],
          type: "object"
        },
        name: "reverse",
        risk: "read"
      }
    ]
  };
}
