import type { WebSearchCitation } from "@muse/model";

export interface SanitiseCitationsResult {
  readonly kept: readonly WebSearchCitation[];
  readonly dropped: number;
}

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

export function sanitiseCitations(
  citations: readonly WebSearchCitation[]
): SanitiseCitationsResult {
  const kept: WebSearchCitation[] = [];
  let dropped = 0;
  for (const c of citations) {
    if (isSafeUrl(c.url)) {
      kept.push(c);
    } else {
      dropped += 1;
    }
  }
  return { kept, dropped };
}

function isSafeUrl(raw: string): boolean {
  if (typeof raw !== "string" || raw.trim().length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  return ALLOWED_PROTOCOLS.has(parsed.protocol);
}
