import { createHash } from "node:crypto";

import type { JsonObject } from "@muse/shared";

import { readString } from "@muse/mcp";
import type { LoopbackMcpServer } from "@muse/mcp";

/**
 * `muse.diff` line-diff utilities — the largest single ambient
 * factory in `loopback.ts` plus its private `lineDiff` LCS helper
 * and `DiffEntry` shape. Lifted out so the (m+1)*(n+1) LCS table
 * code stays co-located with its only call site.
 */

interface DiffEntry {
  readonly kind: "equal" | "insert" | "delete";
  readonly line: string;
  readonly leftLine?: number;
  readonly rightLine?: number;
}

export function createDiffMcpServer(): LoopbackMcpServer {
  const maxLines = 2_000;
  return {
    description: "Built-in line-diff utilities (loopback MCP).",
    name: "muse.diff",
    tools: [
      {
        description:
          "Computes a line-level diff between `left` and `right`. Returns an ordered array of {kind, line} entries where kind is 'equal' / 'insert' (right-only) / 'delete' (left-only). Each entry also carries 1-based leftLine and rightLine indices when applicable.",
        execute: (args): JsonObject => {
          const left = readString(args, "left");
          const right = readString(args, "right");
          if (left === undefined) {
            return { error: "left is required" };
          }
          if (right === undefined) {
            return { error: "right is required" };
          }
          const leftLines = left.split(/\r?\n/u);
          const rightLines = right.split(/\r?\n/u);
          if (leftLines.length > maxLines || rightLines.length > maxLines) {
            return { error: `each side must be at most ${maxLines} lines` };
          }
          const diff = lineDiff(leftLines, rightLines);
          let inserts = 0;
          let deletes = 0;
          for (const entry of diff) {
            if (entry.kind === "insert") {
              inserts += 1;
            } else if (entry.kind === "delete") {
              deletes += 1;
            }
          }
          return {
            deletes,
            diff: diff.map((entry) => ({
              kind: entry.kind,
              line: entry.line,
              ...(entry.leftLine !== undefined ? { leftLine: entry.leftLine } : {}),
              ...(entry.rightLine !== undefined ? { rightLine: entry.rightLine } : {})
            })),
            equals: diff.length - inserts - deletes,
            inserts
          } satisfies JsonObject;
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            left: { type: "string" },
            right: { type: "string" }
          },
          required: ["left", "right"],
          type: "object"
        },
        name: "lines",
        risk: "read"
      },
      {
        description: "Returns true when `left` and `right` are byte-identical, plus the SHA-256 hex digest of each side for quick verification.",
        execute: (args): JsonObject => {
          const left = readString(args, "left");
          const right = readString(args, "right");
          if (left === undefined || right === undefined) {
            return { error: "left and right are required" };
          }
          const leftDigest = createHash("sha256").update(left, "utf8").digest("hex");
          const rightDigest = createHash("sha256").update(right, "utf8").digest("hex");
          return {
            equal: left === right,
            leftDigest,
            rightDigest
          } satisfies JsonObject;
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            left: { type: "string" },
            right: { type: "string" }
          },
          required: ["left", "right"],
          type: "object"
        },
        name: "equal",
        risk: "read"
      }
    ]
  };
}

function lineDiff(left: readonly string[], right: readonly string[]): readonly DiffEntry[] {
  const m = left.length;
  const n = right.length;
  // dp[i][j] = LCS length of left[0..i-1] vs right[0..j-1].
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      if (left[i - 1] === right[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }
  const result: DiffEntry[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (left[i - 1] === right[j - 1]) {
      result.push({ kind: "equal", leftLine: i, line: left[i - 1]!, rightLine: j });
      i -= 1;
      j -= 1;
    } else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) {
      result.push({ kind: "delete", leftLine: i, line: left[i - 1]! });
      i -= 1;
    } else {
      result.push({ kind: "insert", line: right[j - 1]!, rightLine: j });
      j -= 1;
    }
  }
  while (i > 0) {
    result.push({ kind: "delete", leftLine: i, line: left[i - 1]! });
    i -= 1;
  }
  while (j > 0) {
    result.push({ kind: "insert", line: right[j - 1]!, rightLine: j });
    j -= 1;
  }
  return result.reverse();
}
