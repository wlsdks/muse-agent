/**
 * Pure markdown → block-model parser for the terminal chat transcript.
 *
 * Splits an assistant answer into a structured, deterministic block model
 * (headings, paragraphs, fenced code, lists, blockquotes) with inline spans
 * (bold / italic / inline-code / links). No Ink, no colour, no I/O — the Ink
 * renderer in `chat-ink.ts` walks this model and decides styling, so the
 * parser is unit-testable in isolation and the two concerns stay separate.
 *
 * Robustness contract: never throws. Malformed input (an unclosed fence, a
 * stray backtick, a dangling `**`) degrades to plain text — the literal
 * markdown syntax is never surfaced as raw backticks/asterisks to the user.
 */

export interface MdSpan {
  readonly text: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly code?: boolean;
  /** When set, this span is a link: render `text` then a dim ` (url)`. */
  readonly url?: string;
}

export interface MdListItem {
  /** 0-based nesting depth (leading indent / 2, capped). */
  readonly level: number;
  readonly ordered: boolean;
  /** The pre-rendered marker: `•` for unordered, `1.` etc. for ordered. */
  readonly marker: string;
  readonly spans: readonly MdSpan[];
}

export type MdBlock =
  | { readonly kind: "heading"; readonly level: number; readonly spans: readonly MdSpan[] }
  | { readonly kind: "paragraph"; readonly lines: readonly (readonly MdSpan[])[] }
  | { readonly kind: "code"; readonly lang?: string; readonly lines: readonly string[] }
  | { readonly kind: "list"; readonly items: readonly MdListItem[] }
  | { readonly kind: "quote"; readonly lines: readonly (readonly MdSpan[])[] };

const FENCE = /^(\s*)(```|~~~)(\s*([\w.+-]*))?\s*$/u;
const HEADING = /^(#{1,6})\s+(.*)$/u;
const QUOTE = /^\s*>\s?(.*)$/u;
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/u;

/**
 * Tokenise one line of prose into styled spans. Order of alternation is
 * significant: inline code first (so `**` inside a code span stays literal),
 * then links, then `**`/`__` bold before `*`/`_` italic. Unmatched syntax
 * falls through as plain text.
 */
export function parseInlineMarkdown(line: string): MdSpan[] {
  const spans: MdSpan[] = [];
  const re = /`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_/gu;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) spans.push({ text: line.slice(last, m.index) });
    if (m[1] !== undefined) spans.push({ code: true, text: m[1] });
    else if (m[2] !== undefined && m[3] !== undefined) spans.push({ text: m[2], url: m[3] });
    else if (m[4] !== undefined) spans.push({ bold: true, text: m[4] });
    else if (m[5] !== undefined) spans.push({ bold: true, text: m[5] });
    else if (m[6] !== undefined) spans.push({ italic: true, text: m[6] });
    else if (m[7] !== undefined) spans.push({ italic: true, text: m[7] });
    last = m.index + m[0].length;
  }
  if (last < line.length) spans.push({ text: line.slice(last) });
  return spans.length > 0 ? spans : [{ text: line }];
}

/** Rendered marker + ordered flag for a raw list bullet (`-`, `2.`, `3)`). */
function listMarker(raw: string): { ordered: boolean; marker: string } {
  const digits = /^(\d+)[.)]$/u.exec(raw);
  if (digits) return { marker: `${digits[1] ?? ""}.`, ordered: true };
  return { marker: "•", ordered: false };
}

/**
 * Parse a full answer into a block model. Deterministic and total — any input
 * produces a valid `MdBlock[]`, never an exception.
 */
export function parseAnswerMarkdown(text: string): MdBlock[] {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let para: string[] = [];

  const flushPara = (): void => {
    if (para.length > 0) {
      blocks.push({ kind: "paragraph", lines: para.map((l) => parseInlineMarkdown(l)) });
      para = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";

    const fence = FENCE.exec(line);
    if (fence) {
      flushPara();
      const marker = fence[2] ?? "```";
      const lang = (fence[4] ?? "").trim();
      const code: string[] = [];
      i += 1;
      // Collect verbatim until the matching closing fence — or EOF (an
      // unclosed fence still renders as a clean code block, never raw
      // backticks). The fence marker (``` / ~~~) has no regex-special chars.
      const close = new RegExp(`^\\s*${marker}\\s*$`, "u");
      while (i < lines.length && !close.test(lines[i] ?? "")) {
        code.push(lines[i] ?? "");
        i += 1;
      }
      i += 1; // step past the closing fence (or past EOF — harmless)
      blocks.push(lang ? { kind: "code", lang, lines: code } : { kind: "code", lines: code });
      continue;
    }

    if (line.trim() === "") { flushPara(); i += 1; continue; }

    const heading = HEADING.exec(line);
    if (heading) {
      flushPara();
      blocks.push({ kind: "heading", level: (heading[1] ?? "#").length, spans: parseInlineMarkdown(heading[2] ?? "") });
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      flushPara();
      const qlines: MdSpan[][] = [];
      while (i < lines.length) {
        const q = QUOTE.exec(lines[i] ?? "");
        if (!q) break;
        qlines.push(parseInlineMarkdown(q[1] ?? ""));
        i += 1;
      }
      blocks.push({ kind: "quote", lines: qlines });
      continue;
    }

    if (LIST.test(line)) {
      flushPara();
      const items: MdListItem[] = [];
      while (i < lines.length) {
        const lm = LIST.exec(lines[i] ?? "");
        if (!lm) break;
        const indent = (lm[1] ?? "").replace(/\t/gu, "  ").length;
        const { ordered, marker } = listMarker(lm[2] ?? "-");
        items.push({ level: Math.min(Math.floor(indent / 2), 6), marker, ordered, spans: parseInlineMarkdown(lm[3] ?? "") });
        i += 1;
      }
      blocks.push({ kind: "list", items });
      continue;
    }

    para.push(line);
    i += 1;
  }

  flushPara();
  return blocks;
}
