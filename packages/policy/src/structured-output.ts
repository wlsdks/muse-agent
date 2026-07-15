import { errorMessage, isJsonValue } from "@muse/shared";

export type StructuredOutputFormat = "json" | "yaml";

export interface StructuredOutputNormalizationResult {
  readonly content: string;
  readonly normalized: boolean;
  readonly error?: string;
}

export function normalizeStructuredOutput(
  content: string,
  format: StructuredOutputFormat
): StructuredOutputNormalizationResult {
  if (format === "json") {
    return normalizeJsonOutput(content);
  }

  return normalizeYamlOutput(content);
}

function normalizeJsonOutput(content: string): StructuredOutputNormalizationResult {
  const stripped = stripMarkdownFence(content);
  let lastError: string | undefined;
  // Try each balanced block in order, returning the first that PARSES.
  // A small model may emit a non-JSON bracketed preamble before the
  // real value ("see [details below]: {…}"); taking only the
  // first-opener block would forfeit the valid JSON that follows.
  for (const candidate of jsonCandidates(stripped)) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (!isJsonValue(parsed)) {
        lastError = "JSON contains non-finite numbers";
        continue;
      }
      return {
        content: JSON.stringify(parsed, null, 2),
        normalized: true
      };
    } catch (error) {
      lastError = errorMessage(error, "Invalid JSON");
    }
  }
  return {
    content,
    error: lastError ?? "No JSON object or array found",
    normalized: false
  };
}

function normalizeYamlOutput(content: string): StructuredOutputNormalizationResult {
  const stripped = stripMarkdownFence(content).trim();

  if (stripped.length === 0) {
    return { content, error: "No YAML content found", normalized: false };
  }

  return {
    content: stripped,
    normalized: stripped !== content
  };
}

function stripMarkdownFence(content: string): string {
  const trimmed = content.trim();
  const match = trimmed.match(/^```(?:json|ya?ml)?\s*\n(?<body>[\s\S]*?)\n```\s*$/iu);
  return match?.groups?.body ?? trimmed;
}

// Yield each balanced JSON block in first-appearance order — one per
// `{`/`[` opener. The first *balanced* value from an opener (not
// first-opener → last-closer) avoids engulfing trailing prose, and
// yielding successive openers lets the caller skip a non-JSON
// bracketed preamble and recover the valid value after it.
function* jsonCandidates(content: string): Generator<string> {
  const trimmed = content.trim();
  let cursor = 0;
  while (cursor < trimmed.length) {
    const ch = trimmed[cursor];
    if (ch === "{" || ch === "[") {
      const block = firstBalancedJsonBlock(trimmed, cursor);
      if (block !== undefined) {
        yield block;
      }
    }
    cursor += 1;
  }
}

function firstBalancedJsonBlock(input: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = start; index < input.length; index += 1) {
    const ch = input[index];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (ch === "{" || ch === "[") {
      depth += 1;
    } else if (ch === "}" || ch === "]") {
      depth -= 1;
      if (depth === 0) {
        return input.slice(start, index + 1);
      }
    }
  }
  return undefined;
}
