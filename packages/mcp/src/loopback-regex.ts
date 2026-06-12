import type { JsonObject, JsonValue } from "@muse/shared";
import { hasNestedUnboundedQuantifier } from "@muse/tools";

import type { LoopbackMcpServer } from "./loopback.js";
import { readString } from "./loopback-helpers.js";

/**
 * `muse.regex` loopback MCP server — bounded regex utilities.
 *
 * Lifted out of `loopback.ts` (it was the largest single ambient
 * factory remaining — ~162 LOC of three-tool surface plus a small
 * `compile` helper). Same public surface: `createRegexMcpServer()`.
 * Re-exported from `loopback.ts` so the `@muse/mcp` barrel and
 * existing tests keep working without import-site edits.
 *
 * Tools:
 *   - `muse.regex.test`    — `RegExp.test()` semantics
 *   - `muse.regex.match`   — enumerates matches with index/groups
 *   - `muse.regex.replace` — global replace
 *
 * All three reject text > 50,000 chars and pattern > 256 chars,
 * sanitize flag input to `[gimsuy]` only, and propagate compile
 * failures as `{ error: ... }` JSON.
 */
export function createRegexMcpServer(): LoopbackMcpServer {
  const maxTextLength = 50_000;
  const maxPatternLength = 256;
  const defaultMaxMatches = 1_000;

  function compile(pattern: string, flags: string | undefined): RegExp | { readonly error: string } {
    if (pattern.length > maxPatternLength) {
      return { error: `pattern must be at most ${maxPatternLength} characters` };
    }
    const safeFlags = (flags ?? "").replace(/[^gimsuy]/gu, "");
    // A nested unbounded quantifier ((a+)+, (.*)*, ([a-z]+){2,}, …) causes catastrophic
    // backtracking that HANGS the whole agent process (a sync regex run on the main
    // thread can't be timed out). Reject it BEFORE `new RegExp`, reusing the proven
    // escape-aware star-height check `regex_extract` already uses — same bug class,
    // previously unfixed on this surface.
    if (hasNestedUnboundedQuantifier(pattern)) {
      return { error: "pattern looks vulnerable to catastrophic backtracking (a quantified group whose body is also unbounded, e.g. (a+)+) — simplify it" };
    }
    try {
      return new RegExp(pattern, safeFlags);
    } catch (error) {
      return { error: `invalid pattern: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  return {
    description: "Built-in bounded regex utilities (loopback MCP).",
    name: "muse.regex",
    tools: [
      {
        description: "Returns true if the pattern matches anywhere in the text. Equivalent to RegExp.test().",
        execute: (args): JsonObject => {
          const text = readString(args, "text");
          const pattern = readString(args, "pattern");
          if (text === undefined) {
            return { error: "text is required" };
          }
          if (pattern === undefined) {
            return { error: "pattern is required" };
          }
          if (text.length > maxTextLength) {
            return { error: `text must be at most ${maxTextLength} characters` };
          }
          const regex = compile(pattern, readString(args, "flags"));
          if (regex instanceof RegExp) {
            return { matched: regex.test(text) } satisfies JsonObject;
          }
          return regex;
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            flags: { type: "string" },
            pattern: { type: "string" },
            text: { type: "string" }
          },
          required: ["text", "pattern"],
          type: "object"
        },
        name: "test",
        risk: "read"
      },
      {
        description:
          "Returns up to `maxMatches` (default 1000) matches with their index and capture groups. Forces the global flag to enumerate every occurrence.",
        execute: (args): JsonObject => {
          const text = readString(args, "text");
          const pattern = readString(args, "pattern");
          if (text === undefined) {
            return { error: "text is required" };
          }
          if (pattern === undefined) {
            return { error: "pattern is required" };
          }
          if (text.length > maxTextLength) {
            return { error: `text must be at most ${maxTextLength} characters` };
          }
          const maxMatchesValue = args.maxMatches;
          const cap =
            typeof maxMatchesValue === "number" && Number.isInteger(maxMatchesValue) && maxMatchesValue > 0
              ? Math.min(maxMatchesValue, defaultMaxMatches * 10)
              : defaultMaxMatches;
          const flags = (readString(args, "flags") ?? "").replace(/[^gimsuy]/gu, "");
          const compiled = compile(pattern, flags.includes("g") ? flags : `${flags}g`);
          if (!(compiled instanceof RegExp)) {
            return compiled;
          }
          const matches: { value: string; index: number; groups?: readonly string[] }[] = [];
          let truncated = false;
          let result: RegExpExecArray | null;
          while ((result = compiled.exec(text)) !== null) {
            if (matches.length >= cap) {
              truncated = true;
              break;
            }
            matches.push({
              groups: result.length > 1 ? result.slice(1).map((value) => value ?? "") : undefined,
              index: result.index,
              value: result[0]
            });
            // Advance on zero-width matches so the loop terminates.
            if (result.index === compiled.lastIndex) {
              compiled.lastIndex += 1;
            }
          }
          return {
            matches: matches.map((entry) => ({
              index: entry.index,
              value: entry.value,
              ...(entry.groups ? { groups: entry.groups as JsonValue } : {})
            })) as JsonValue,
            truncated
          } satisfies JsonObject;
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            flags: { type: "string" },
            maxMatches: { type: "integer", minimum: 1 },
            pattern: { type: "string" },
            text: { type: "string" }
          },
          required: ["text", "pattern"],
          type: "object"
        },
        name: "match",
        risk: "read"
      },
      {
        description: "Replaces every match with `replacement`. Forces the global flag so all occurrences are replaced.",
        execute: (args): JsonObject => {
          const text = readString(args, "text");
          const pattern = readString(args, "pattern");
          const replacement = readString(args, "replacement");
          if (text === undefined) {
            return { error: "text is required" };
          }
          if (pattern === undefined) {
            return { error: "pattern is required" };
          }
          if (replacement === undefined) {
            return { error: "replacement is required" };
          }
          if (text.length > maxTextLength) {
            return { error: `text must be at most ${maxTextLength} characters` };
          }
          const flags = (readString(args, "flags") ?? "").replace(/[^gimsuy]/gu, "");
          const compiled = compile(pattern, flags.includes("g") ? flags : `${flags}g`);
          if (!(compiled instanceof RegExp)) {
            return compiled;
          }
          return { result: text.replace(compiled, replacement) } satisfies JsonObject;
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            flags: { type: "string" },
            pattern: { type: "string" },
            replacement: { type: "string" },
            text: { type: "string" }
          },
          required: ["text", "pattern", "replacement"],
          type: "object"
        },
        name: "replace",
        risk: "read"
      }
    ]
  };
}
