import type { JsonObject } from "@muse/shared";

import { evaluateArithmeticExpression, readString, type LoopbackMcpServer } from "@muse/mcp";

/**
 * `muse.math` safe arithmetic loopback MCP server. The deterministic
 * evaluator (`evaluateArithmeticExpression`, no `eval`) is a shared
 * primitive kept in `@muse/mcp` — `muse ask`'s pure-arithmetic
 * fast-path routes through the same core so a calculation never
 * depends on the local model's digits.
 */
export function createMathMcpServer(): LoopbackMcpServer {
  return {
    description: "Safe arithmetic evaluation (loopback MCP).",
    name: "muse.math",
    tools: [
      {
        description:
          "Evaluate an EXACT arithmetic expression — digits, parentheses, '.', ',' and + - * / %. " +
          "Use this for ANY calculation the answer depends on (a percentage, total, difference, share, " +
          "monthly→yearly, etc.): expression='840000 * 0.18' for '18% of 840,000', '(1200 + 850) / 2' " +
          "for the average of two numbers, '340 * 24' for '$340 a month for 2 years'. Do the maths HERE, " +
          "NEVER in your head — you will get the digits wrong otherwise. Returns { expression, result }. " +
          "Do NOT use for symbolic algebra, unit conversion, or date arithmetic.",
        keywords: ["math", "calculate", "calculation", "arithmetic", "compute", "percent", "percentage", "sum", "total", "average", "multiply", "divide", "how much", "계산", "퍼센트", "얼마", "합계"],
        execute: (args): JsonObject => {
          const expression = (readString(args, "expression") ?? "").trim();
          const evaluated = evaluateArithmeticExpression(expression);
          if ("error" in evaluated) {
            return { error: evaluated.error };
          }
          return { expression, result: evaluated.result } satisfies JsonObject;
        },
        inputSchema: {
          additionalProperties: false,
          properties: { expression: { description: "The arithmetic expression to evaluate, e.g. '840000 * 0.18' or '(1200 + 850) / 2'. Digits, parentheses, '.', ',' and + - * / % only.", type: "string" } },
          required: ["expression"],
          type: "object"
        },
        name: "evaluate",
        risk: "read"
      }
    ]
  };
}
