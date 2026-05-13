/**
 * Pinned-entity extractor — pulls up to 5 short "anchor" phrases
 * from the user-authored turns being compacted out of the
 * conversation. Captures three families:
 *   - issue keys (`PROJ-1234`)
 *   - Korean/English entity phrases ending in a domain noun
 *     (`결제 모듈`, `auth 서비스`, …)
 *   - quoted terms (`"hashing"`, `「세금공제」`, `'q3 budget memo'`)
 *
 * The list is folded back into the `[Conversation summary: …]`
 * system message that the trimmer inserts, so the model retains
 * concrete nouns long after the originating turns are gone.
 *
 * Extracted from `memory-token-trim.ts` so the trimming-algorithm
 * file no longer mixes "pick anchors" pattern-matching with the
 * boundary-respecting message removal loop.
 */

import type { ConversationMessage } from "./index.js";

const issueKeyPattern = /\b[A-Z][A-Z0-9]+-\d+\b/gu;
const entityNounPattern =
  /(?<noun>[가-힣A-Za-z]{2,}(?:\s+[가-힣A-Za-z0-9]{2,}){0,3})\s*(?<type>버그|이슈|기능|모듈|프로젝트|시스템|서비스|페이지|문서)/gu;
const quotedEntityPattern = /["'「『](?<term>[^"'」』\n]{2,50})["'」』]/gu;
const maxPinnedEntities = 5;

export function extractPinnedEntities(messages: readonly ConversationMessage[]): readonly string[] {
  const collected = new Set<string>();

  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }

    for (const match of message.content.matchAll(issueKeyPattern)) {
      addPinnedEntity(collected, match[0]);
    }

    if (collected.size >= maxPinnedEntities) {
      break;
    }

    for (const match of message.content.matchAll(entityNounPattern)) {
      const groups = match.groups ?? {};
      addPinnedEntity(collected, `${groups.noun?.trim() ?? ""} ${groups.type ?? ""}`);
    }

    if (collected.size >= maxPinnedEntities) {
      break;
    }

    for (const match of message.content.matchAll(quotedEntityPattern)) {
      addPinnedEntity(collected, match.groups?.term?.trim() ?? "");
    }

    if (collected.size >= maxPinnedEntities) {
      break;
    }
  }

  return [...collected].slice(0, maxPinnedEntities);
}

function addPinnedEntity(collected: Set<string>, value: string): void {
  const normalized = value.replace(/\s+/gu, " ").trim();

  if (normalized.length > 0 && collected.size < maxPinnedEntities) {
    collected.add(normalized);
  }
}
