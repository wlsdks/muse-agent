import type { ModelMessage, ModelResponse } from "@muse/model";
import { isRecord, type JsonObject } from "@muse/shared";
import type { VerifiedSource } from "./types.js";

/**
 * Shared internal helpers for `@muse/agent-core` submodules.
 *
 * These are intentionally private to the package (not re-exported from
 * `index.ts`). Consumers depending on stable API should use the typed
 * primitives — these helpers exist so guard / response-filter / runtime
 * submodules can share message and JSON parsing logic without circular
 * imports.
 */

export interface LlmClassificationDecision {
  readonly action: "allow" | "block";
  readonly category?: string;
  readonly reason?: string;
}

export function joinMessages(messages: readonly ModelMessage[]): string {
  return messages
    .filter((message) => message.role === "user" || message.role === "system")
    .map((message) => message.content)
    .join("\n");
}

export function joinUserMessages(messages: readonly ModelMessage[]): string {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .join("\n");
}

export function parseLlmClassificationDecision(output: string): LlmClassificationDecision {
  const parsed = parseJsonObjectFromText(output);

  if (!parsed) {
    throw new Error("LLM classification guard returned an invalid decision");
  }

  const action = typeof parsed.action === "string" ? parsed.action.toLowerCase() : undefined;

  if (action === "allow") {
    return {
      action: "allow",
      category: stringField(parsed.category),
      reason: stringField(parsed.reason)
    };
  }

  if (action === "block" || action === "deny" || action === "reject") {
    return {
      action: "block",
      category: stringField(parsed.category),
      reason: stringField(parsed.reason)
    };
  }

  throw new Error("LLM classification guard returned an unknown action");
}

export function parseJsonObjectFromText(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fencedMatch = /```(?:json)?\s*([\s\S]*?)\s*```/iu.exec(trimmed);

  if (fencedMatch?.[1]) {
    candidates.push(fencedMatch[1].trim());
  }

  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");

  if (objectStart >= 0 && objectEnd > objectStart) {
    candidates.push(trimmed.slice(objectStart, objectEnd + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);

      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Continue through fallback candidates.
    }
  }

  return undefined;
}

export function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export { isRecord };

export function withResponseFilterRaw(response: ModelResponse, id: string): JsonObject {
  return {
    ...(isRecord(response.raw) ? response.raw : {}),
    museResponseFilter: { id }
  };
}

export interface MarkdownSegment {
  readonly isCode: boolean;
  readonly text: string;
}

export function splitOnCodeFences(text: string): readonly MarkdownSegment[] {
  const segments: { isCode: boolean; text: string }[] = [];
  let cursor = 0;
  let inCode = false;
  let buffer = "";

  while (cursor < text.length) {
    if (text.startsWith("```", cursor)) {
      if (buffer.length > 0) {
        segments.push({ isCode: inCode, text: buffer });
        buffer = "";
      }
      buffer += "```";
      cursor += 3;
      inCode = !inCode;
      continue;
    }

    buffer += text[cursor];
    cursor += 1;
  }

  if (buffer.length > 0) {
    segments.push({ isCode: inCode, text: buffer });
  }

  return segments;
}

export function transformMarkdownText(text: string): string {
  let result = text
    .replace(/\*\*([^*\n]*[a-zA-Z0-9가-힣ㄱ-ㅎㅏ-ㅣ][^*\n]*)\*\*/g, "*$1*")
    .replace(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm, (_, heading: string) => `*${heading.replaceAll("*", "").trim()}*`)
    .replace(/\[([^\]\n]+)]\((https?:\/\/[^\s)]+)\)/g, "<$2|$1>")
    .replace(/^\s*([-*_])\1{2,}\s*$/gm, "");

  result = markdownTablesToBullets(result);
  return result;
}

function markdownTablesToBullets(text: string): string {
  const lines = text.split("\n");
  const output: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const separator = lines[index + 1] ?? "";

    if (!isMarkdownTableRow(line) || !isMarkdownTableSeparator(separator)) {
      output.push(line);
      index += 1;
      continue;
    }

    const headers = parseMarkdownTableRow(line);
    index += 2;

    while (index < lines.length && isMarkdownTableRow(lines[index] ?? "")) {
      const cells = parseMarkdownTableRow(lines[index] ?? "");
      const parts = headers.map((header, cellIndex) => {
        const cell = cells[cellIndex] ?? "";
        return header.length > 0 ? `*${header}*: ${cell}` : cell;
      });
      output.push(`• ${parts.join(", ")}`);
      index += 1;
    }
  }

  return output.join("\n");
}

function isMarkdownTableRow(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith("|") && trimmed.indexOf("|", 1) > 0;
}

function isMarkdownTableSeparator(line: string): boolean {
  return line.trimStart().startsWith("|") && /:?-{3,}:?/.test(line);
}

function parseMarkdownTableRow(line: string): readonly string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

export function extractApologyLead(content: string, patterns: readonly string[]): string | undefined {
  const trimmed = content.trimStart();
  const firstBreak = trimmed.indexOf("\n\n");
  const candidate = firstBreak > 0 ? trimmed.slice(0, firstBreak) : trimmed;

  if (candidate.length > 300) {
    return undefined;
  }

  const lower = candidate.toLowerCase();
  return patterns.some((pattern) => lower.includes(pattern)) ? candidate : undefined;
}

export function resolveActualResponseCount(body: string, sources: readonly VerifiedSource[]): number {
  if (sources.length > 0) {
    return sources.length;
  }

  const bullets = body.match(/^\s*(?:[-•*]|\d+\.)\s+\S/gm)?.length ?? 0;

  if (bullets > 0) {
    return bullets;
  }

  const urls = new Set(body.match(/https?:\/\/[^\s)>"']+/g) ?? []);

  if (urls.size > 0) {
    return urls.size;
  }

  if (/찾지\s*못했|찾을\s*수\s*없|없습니다|없어요|0\s*(?:건|개)|not\s+found|no\s+(?:results?|items?|matches?)/i.test(body)) {
    return 0;
  }

  return -1;
}

export function isSignificantCountMismatch(asserted: number, actual: number): boolean {
  return (actual === 0 && asserted > 0) || Math.abs(asserted - actual) >= 2;
}

export function normalizeSourceUrl(url: string): string {
  return url.replace(/#.*$/u, "").replace(/\/+$/u, "");
}

export function splitPreservingSentencePunctuation(text: string): readonly string[] {
  const sentences: string[] = [];
  let start = 0;
  const boundaryPattern = /[.!?]+/g;
  let match: RegExpExecArray | null;

  while ((match = boundaryPattern.exec(text)) !== null) {
    sentences.push(text.slice(start, match.index + match[0].length).trim());
    start = match.index + match[0].length;
  }

  if (start < text.length) {
    const tail = text.slice(start).trim();

    if (tail.length > 0) {
      sentences.push(tail);
    }
  }

  return sentences.filter((sentence) => /\p{L}/u.test(sentence));
}
