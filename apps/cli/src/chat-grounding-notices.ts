import { detectEvidenceContradictions, evidenceIsUntrustedOnly, groundedOnUntrustedOnly, reportCitationPrecision, reportCitationRecall, untrustedOnlySentences, type KnowledgeMatch } from "@muse/agent-core";



import { expressesNoInformation, isChatAbstention } from "./chat-grounding-verdict.js";
import { embed } from "./embed.js";
import { DEFAULT_EMBED_MODEL } from "./embed-model-default.js";
import { withBestEffort } from "./async-promises.js";

/**
 * Chat parity of the ask path's semantic value-conflict surfacing: when two of
 * the user's OWN retrieved notes assert a DIFFERENT value for the SAME fact in
 * free prose, name BOTH sources so the user can reconcile — rather than letting
 * the answer silently cite the half it happened to match (a grounded≠true lie).
 * Precision-first via {@link detectEvidenceContradictions} (topic-cosine +
 * neither-subset). Fail-open: any embed error → no cue. First pair only.
 */
/**
 * The production embedder both chat surfaces pass as `embed` so the semantic
 * conflict cue runs live — the same recall embed model the chat retrieval uses.
 */
export function defaultChatConflictEmbedder(
  env: Record<string, string | undefined> = process.env
): (text: string) => Promise<readonly number[]> {
  const embedModel = env.MUSE_RECALL_EMBED_MODEL?.trim() || DEFAULT_EMBED_MODEL;
  return (text: string) => embed(text, embedModel);
}

export async function semanticConflictCueFromMatches(
  matches: readonly KnowledgeMatch[],
  embed: (text: string) => Promise<readonly number[]>
): Promise<string | undefined> {
  if (matches.length < 2) return undefined;
  const pairs = await withBestEffort(detectEvidenceContradictions(matches, embed), []);
  const pair = pairs[0];
  if (pair === undefined) return undefined;
  const a = matches[pair.aIndex];
  const b = matches[pair.bIndex];
  if (a === undefined || b === undefined) return undefined;
  const isKo = /[가-힣]/u.test(`${a.text} ${b.text}`);
  // Trust-aware (grounded≠true): when exactly ONE side is an untrusted source
  // (feed / MCP-or-web tool output / poisoned episode / URL-ingested note —
  // `trusted:false`) and the other is the user's OWN data, a poisonable source is
  // contradicting the user's own. A neutral "sources disagree" lets the external
  // value look as authoritative as the user's note — so NAME the asymmetry and
  // point the user at their own data, not the poison (the canonical poisoned-
  // source override). Both-same-trust keeps the symmetric "verify which" cue.
  const aUntrusted = a.trusted === false;
  const bUntrusted = b.trusted === false;
  if (aUntrusted !== bUntrusted) {
    const own = aUntrusted ? b : a;
    const ext = aUntrusted ? a : b;
    return isKo
      ? `⚠️ 출처 충돌: 외부·미검증 출처 '${ext.source}'가 당신의 '${own.source}'와 다른 값을 말합니다 — 당신의 출처를 신뢰하고 외부 값을 확인하세요.`
      : `⚠️ Source conflict: an external/unverified source '${ext.source}' disagrees with your own '${own.source}' — trust your own and verify the external value.`;
  }
  return isKo
    ? `⚠️ 노트 충돌: '${a.source}'와 '${b.source}'가 같은 사실을 다르게 적고 있어요 — 어느 쪽이 맞는지 확인해 주세요.`
    : `⚠️ Sources disagree: '${a.source}' and '${b.source}' state different values for the same fact — verify which is correct.`;
}

function truncateClaim(sentence: string): string {
  return sentence.length > 80 ? `${sentence.slice(0, 80)}…` : sentence;
}

/** Chat parity of the ask path's citation-precision cue (ALCE, arXiv:2305.14627). */
export function chatCitationPrecisionNotice(answer: string, matches: readonly KnowledgeMatch[]): string | undefined {
  const sentence = reportCitationPrecision(answer, matches).unsupported[0];
  if (sentence === undefined) return undefined;
  return `⚠️ Citation check: a cited source doesn't actually support "${truncateClaim(sentence)}" — verify the citation.`;
}

/** Chat parity of the ask path's citation-recall cue (a groundable claim with no citation). */
export function chatCitationRecallNotice(answer: string, matches: readonly KnowledgeMatch[]): string | undefined {
  const sentence = reportCitationRecall(answer, matches).uncited[0];
  if (sentence === undefined) return undefined;
  return `⚠️ Attribution check: "${truncateClaim(sentence)}" matches your notes but carries no citation.`;
}

/**
 * grounded≠true SOURCE-TRUST cue for the chat surface — the parity of the ask
 * path's `untrustedOnlyGroundingNotice`. Fires on a faithful (non-abstention)
 * answer whose every resolving citation points only at untrusted provenance
 * (MCP/web tool output, `trusted:false`). A single trusted note clears it.
 */
export function untrustedOnlyChatNotice(answer: string, evidence: readonly KnowledgeMatch[]): string | undefined {
  if (answer.trim().length === 0 || isChatAbstention(answer) || expressesNoInformation(answer)) return undefined;
  // EITHER the citation-based check OR the deterministic structural one (the whole
  // evidence pool is tool-fetched) — so a non-citing but grounded answer still gets
  // the cue (the local 8B may omit the [from <src>] marker). The abstention guard
  // above keeps this off a non-answer even when only untrusted evidence is present.
  if (groundedOnUntrustedOnly(answer, evidence) || evidenceIsUntrustedOnly(evidence)) {
    return "\n\n⚠️ 출처 확인: 이 답변은 출처에 충실하지만 도구로 가져온 데이터(tool-fetched)에만 근거합니다 — 직접 확인 후 신뢰하세요.";
  }
  // Per-claim provenance: a mixed answer can rest one claim solely on a
  // poisonable tool-fetched source even when another citation is trusted.
  const untrusted = untrustedOnlySentences(answer, evidence);
  if (untrusted.length > 0) {
    return `\n\n⚠️ 출처 확인: 한 가지 내용이 도구로 가져온 데이터에만 근거합니다 — 직접 확인하세요: "${untrusted[0]}"`;
  }
  return undefined;
}
