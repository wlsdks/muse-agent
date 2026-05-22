export type SourceBlockRemovalReason = "empty_source_block" | "linked_source_block";

export interface SourceBlockSanitizationResult {
  readonly content: string;
  readonly removed: boolean;
  readonly reason?: SourceBlockRemovalReason;
}

export function sanitizeSourceBlocks(content: string): SourceBlockSanitizationResult {
  const lines = content.split(/\r?\n/u);
  const sourceBlock = findTrailingSourceBlock(lines);

  if (!sourceBlock) {
    return { content, removed: false };
  }

  const block = sourceBlock.blockLines.map((line) => line.trim()).filter(Boolean);
  const reason = classifySourceBlock(block);

  if (!reason) {
    return { content, removed: false };
  }

  return {
    content: lines.slice(0, sourceBlock.headingIndex).join("\n").trimEnd(),
    reason,
    removed: true
  };
}

interface SourceBlockCandidate {
  readonly blockLines: readonly string[];
  readonly headingIndex: number;
}

function findTrailingSourceBlock(lines: readonly string[]): SourceBlockCandidate | undefined {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = lines[index]?.match(sourceHeadingPattern);

    if (!match) {
      continue;
    }

    const rest = match.groups?.rest?.trim();
    const blockLines = [
      ...(rest ? [rest] : []),
      ...lines.slice(index + 1)
    ];

    return {
      blockLines: trimTrailingBlankLines(blockLines),
      headingIndex: index
    };
  }

  return undefined;
}

function classifySourceBlock(lines: readonly string[]): SourceBlockRemovalReason | undefined {
  if (lines.length === 0 || lines.every(isEmptySourceFallback)) {
    return "empty_source_block";
  }

  if (lines.every(isSourceListLine) && lines.some(hasSourceEvidence)) {
    return "linked_source_block";
  }

  return undefined;
}

function trimTrailingBlankLines(lines: readonly string[]): readonly string[] {
  let end = lines.length;

  while (end > 0 && (lines[end - 1]?.trim().length ?? 0) === 0) {
    end -= 1;
  }

  return lines.slice(0, end);
}

function isEmptySourceFallback(line: string): boolean {
  const normalized = line.replace(sourceListPrefixPattern, "").trim();
  return emptySourceFallbackPatterns.some((pattern) => pattern.test(normalized));
}

function isSourceListLine(line: string): boolean {
  return sourceListLinePattern.test(line) || sourceReferenceLinePattern.test(line);
}

function hasSourceEvidence(line: string): boolean {
  return /https?:\/\/\S+/iu.test(line) || /\b(doi|arxiv):\S+/iu.test(line);
}

// Korean source headings (출처 / 참고 / 참고 자료 / 근거) sit alongside
// the English ones — Muse is Korean-first, so a Qwen response's
// trailing "출처: 없음" must be recognised the same as "Sources: None".
// The block classifier still gates removal, so a legitimate "참고:"
// prose note (no URL, not an empty-fallback) is never stripped.
const sourceHeadingPattern = /^\s{0,3}(?:sources?|references?|출처|참고\s*자료|참고|근거)\s*[:：]\s*(?<rest>.*)$/iu;
const sourceListPrefixPattern = /^\s*(?:[-*+]|\d+[.)]|\[\d+\])\s+/u;
const sourceListLinePattern = /^\s*(?:[-*+]|\d+[.)]|\[\d+\])\s+\S+/u;
const sourceReferenceLinePattern = /^\s*\[\d+\]:\s+\S+/u;

const emptySourceFallbackPatterns = [
  /^none\.?$/iu,
  /^n\/a\.?$/iu,
  /^not provided\.?$/iu,
  /^no sources?\.?$/iu,
  /^no verified sources?\.?$/iu,
  /^sources? unavailable\.?$/iu,
  /^no sources? available\.?$/iu,
  /^the available sources? do not answer this\.?$/iu,
  /^없음\.?$/u,
  /^해당\s*없음\.?$/u,
  /^출처\s*없음\.?$/u,
  /^확인된?\s*출처(?:가|는)?\s*없(?:음|습니다)\.?$/u,
  /^참고\s*자료\s*없음\.?$/u
] as const;
