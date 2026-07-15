// LLM judge output often wraps the JSON array in prose (preamble/trailer);
// only the first balanced top-level array is trustworthy — anything else is discarded.
export function parseJudgeStringArray(raw: string): readonly string[] {
  const first = raw.indexOf("[");
  if (first < 0) return [];
  let depth = 0;
  let body = "";
  for (let i = first; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        body = raw.slice(first, i + 1);
        break;
      }
    }
  }
  if (!body) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(body) as unknown; } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is string => typeof item === "string" && item.length > 0);
}
