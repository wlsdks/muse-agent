import type { ReactNode } from "react";

/**
 * Minimal, dependency-free Markdown renderer for chat replies. Handles
 * fenced code blocks, headings, bullet/numbered lists, blockquotes, and
 * inline `code` / **bold** / *italic* / [links](url). It never emits raw
 * HTML (no dangerouslySetInnerHTML), so model output cannot inject markup
 * — every node is a known React element.
 */
export function Markdown({ text }: { text: string }) {
  return <>{renderBlocks(text)}</>;
}

function renderBlocks(text: string): ReactNode[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    // Fenced code block.
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? "")) {
        body.push(lines[i] ?? "");
        i += 1;
      }
      i += 1; // closing fence
      out.push(
        <pre className="md-pre" key={key++}>
          <code>{body.join("\n")}</code>
        </pre>
      );
      continue;
    }

    // Heading.
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      const Tag = (`h${Math.min(level + 2, 6)}`) as "h3" | "h4" | "h5" | "h6";
      out.push(
        <Tag className="md-h" key={key++}>
          {renderInline(heading[2] ?? "")}
        </Tag>
      );
      i += 1;
      continue;
    }

    // Blockquote.
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i] ?? "")) {
        quote.push((lines[i] ?? "").replace(/^>\s?/, ""));
        i += 1;
      }
      out.push(
        <blockquote className="md-quote" key={key++}>
          {renderInline(quote.join(" "))}
        </blockquote>
      );
      continue;
    }

    // List (bullet or numbered).
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\s*([-*]|\d+\.)\s+/, ""));
        i += 1;
      }
      const children = items.map((it, idx) => <li key={idx}>{renderInline(it)}</li>);
      out.push(
        ordered ? (
          <ol className="md-list" key={key++}>
            {children}
          </ol>
        ) : (
          <ul className="md-list" key={key++}>
            {children}
          </ul>
        )
      );
      continue;
    }

    // Blank line.
    if (line.trim() === "") {
      i += 1;
      continue;
    }

    // Paragraph: gather consecutive non-blank, non-structural lines.
    const para: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() !== "" &&
      !/^```/.test(lines[i] ?? "") &&
      !/^(#{1,4})\s/.test(lines[i] ?? "") &&
      !/^>\s?/.test(lines[i] ?? "") &&
      !/^\s*([-*]|\d+\.)\s+/.test(lines[i] ?? "")
    ) {
      para.push(lines[i] ?? "");
      i += 1;
    }
    out.push(
      <p className="md-p" key={key++}>
        {renderInline(para.join(" "))}
      </p>
    );
  }

  return out;
}

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;

function renderInline(text: string): ReactNode[] {
  const parts = text.split(INLINE).filter((p) => p !== "");
  return parts.map((part, idx) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code className="md-code" key={idx}>
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={idx}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("*") && part.endsWith("*")) {
      return <em key={idx}>{part.slice(1, -1)}</em>;
    }
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      const href = link[2] ?? "";
      // Scheme allowlist: http(s)/mailto/tel are inert; anything else
      // (javascript:, data:, vbscript:) collapses to "#" so untrusted
      // model output can't smuggle an executable URL into an anchor.
      const safe = /^(https?:\/\/|mailto:|tel:)/i.test(href) ? href : "#";
      return (
        <a key={idx} href={safe} target="_blank" rel="noreferrer">
          {link[1]}
        </a>
      );
    }
    return <span key={idx}>{part}</span>;
  });
}
