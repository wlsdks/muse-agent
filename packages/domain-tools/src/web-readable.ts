/**
 * Minimal, dependency-free HTML → readable-text extraction for
 * `muse.web.read`. A local model grounds far better on clean prose than
 * on raw markup, and pulling in a DOM (jsdom + readability) for a
 * single-user local assistant is a heavy, non-local-first dependency.
 * This strips the noise (script/style/nav chrome), turns block
 * boundaries into newlines, and decodes the common entities — enough to
 * answer "summarize this page" without a browser.
 */

export interface ReadableResult {
  readonly title: string | undefined;
  readonly text: string;
  /** True when the extracted text was cut to `maxChars`. */
  readonly truncated: boolean;
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: "\""
});

function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/giu, (match, body: string) => {
    if (body.startsWith("#")) {
      const isHex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

function extractTitle(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html);
  if (!match) return undefined;
  const title = decodeEntities(match[1] as string).replace(/\s+/gu, " ").trim();
  return title.length > 0 ? title : undefined;
}

const BLOCK_CLOSE = /<\/(p|div|section|article|header|footer|li|ul|ol|tr|table|h[1-6]|blockquote|pre|figure)\s*>/giu;
const LINE_BREAK = /<br\s*\/?>/giu;

export function extractReadableText(html: string, options: { readonly maxChars?: number } = {}): ReadableResult {
  const maxChars = options.maxChars ?? 16_000;
  const title = extractTitle(html);

  // nav/footer are HTML5 boilerplate (menus, copyright, link farms) — dropping
  // them with script/style sharpens the readable text the model grounds on,
  // so a summary cites the article, not the site chrome.
  let body = html
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/<(script|style|noscript|svg|template|head|nav|footer)[\s\S]*?<\/\1\s*>/giu, " ");

  body = body.replace(LINE_BREAK, "\n").replace(BLOCK_CLOSE, "\n");
  body = body.replace(/<[^>]+>/gu, " ");
  body = decodeEntities(body);

  const text = body
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/gu, " ").trim())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();

  if (text.length > maxChars) {
    return { title, text: text.slice(0, maxChars).trimEnd(), truncated: true };
  }
  return { title, text, truncated: false };
}
