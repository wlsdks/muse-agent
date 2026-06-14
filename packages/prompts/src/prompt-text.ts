/**
 * Tiny pure helpers for compacting optional prompt text: trim-or-undefined a
 * block, and drop the undefined entries from a list of sections/lines. Split out
 * of index.ts so the prompt builders import them rather than redefining.
 */

export function cleanBlock(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

export function compactSections(sections: readonly (string | undefined)[]): readonly string[] {
  return sections.map(cleanBlock).filter((section): section is string => section !== undefined);
}

export function compactLines(lines: readonly (string | undefined)[]): readonly string[] {
  return lines.filter((line): line is string => line !== undefined);
}
