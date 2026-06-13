import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Markdown } from "./markdown.js";

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

describe("Markdown", () => {
  it("renders fenced code blocks as <pre><code>", () => {
    const out = html("```\nconst x = 1;\n```");
    expect(out).toContain("<pre");
    expect(out).toContain("const x = 1;");
  });

  it("renders inline bold, italic, and code", () => {
    const out = html("This is **bold**, *italic*, and `code`.");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<em>italic</em>");
    expect(out).toContain("code");
    expect(out).toContain("md-code");
  });

  it("renders bullet lists", () => {
    const out = html("- one\n- two");
    expect(out).toContain("<ul");
    expect(out).toContain(">one<");
    expect(out).toContain(">two<");
    expect(out.match(/<li>/g)).toHaveLength(2);
  });

  it("renders safe links and rejects javascript: URLs", () => {
    const safe = html("see [docs](https://example.com)");
    expect(safe).toContain('href="https://example.com"');
    const unsafe = html("[x](javascript:alert(1))");
    expect(unsafe).not.toContain("javascript:");
    expect(unsafe).toContain('href="#"');
  });

  it("never emits a raw script tag from model text", () => {
    const out = html("<script>alert(1)</script>");
    expect(out).not.toContain("<script>");
  });

  it("renders mailto: and tel: links so contact replies are clickable", () => {
    const mail = html("reach me at [bob@x.com](mailto:bob@x.com)");
    expect(mail).toContain('href="mailto:bob@x.com"');
    const phone = html("call [the desk](tel:+15551234567)");
    expect(phone).toContain('href="tel:+15551234567"');
  });

  it("blocks dangerous link schemes beyond javascript:", () => {
    const data = html("[x](data:text/html,<script>alert(1)</script>)");
    expect(data).not.toContain("data:text/html");
    expect(data).toContain('href="#"');
    const vbscript = html("[x](vbscript:msgbox(1))");
    expect(vbscript).not.toContain("vbscript:");
    expect(vbscript).toContain('href="#"');
  });
});
