import { describe, expect, it } from "vitest";

import { decodeHeaderValue, extractBody, ingestMbox, looksLikeMbox, parseHeaders, splitMboxMessages, stripHtml } from "./mbox-ingest.js";

const MBOX = [
  "From alice@x.com Mon Jan 1 00:00:00 2026",
  "From: Alice <alice@x.com>",
  "To: me@y.com",
  "Subject: Lunch Tuesday",
  "Date: Mon, 01 Jan 2026 09:00:00 +0000",
  "",
  "Let's do lunch Tuesday at noon.",
  "From the office cafeteria works.", // a body line starting with "From " — must NOT split
  "",
  "From bob@x.com Tue Jan 2 00:00:00 2026",
  "From: Bob <bob@x.com>",
  "Subject: =?UTF-8?Q?Caf=C3=A9_plan?=",
  "Content-Transfer-Encoding: quoted-printable",
  "",
  "Meet at the caf=C3=A9 at 3pm.="
].join("\n");

describe("splitMboxMessages", () => {
  it("splits on mbox 'From ' separators but not on a body line that starts with 'From '", () => {
    const msgs = splitMboxMessages(MBOX);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toContain("Subject: Lunch Tuesday");
    expect(msgs[0]).toContain("From the office cafeteria works."); // stayed in message 1's body
    expect(msgs[1]).toContain("Bob <bob@x.com>");
  });
});

describe("parseHeaders", () => {
  it("lowercases names, unfolds continuations, and returns the body after the blank line", () => {
    const raw = ["Subject: a very", " long subject", "From: x@y.com", "", "the body", "line two"].join("\n");
    const { headers, body } = parseHeaders(raw);
    expect(headers.get("subject")).toBe("a very long subject");
    expect(headers.get("from")).toBe("x@y.com");
    expect(body).toBe("the body\nline two");
  });
});

describe("decoders", () => {
  it("decodeHeaderValue handles RFC-2047 Q and B encoded-words (utf-8)", () => {
    expect(decodeHeaderValue("=?UTF-8?Q?Caf=C3=A9_plan?=")).toBe("Café plan");
    expect(decodeHeaderValue("=?UTF-8?B?7JWI64WV?=")).toBe("안녕");
  });
  it("stripHtml drops script/style + tags and decodes basic entities", () => {
    expect(stripHtml("<style>x{}</style><p>Hi&nbsp;&amp; bye <b>now</b></p>")).toBe("Hi & bye now");
  });
});

describe("extractBody", () => {
  it("decodes quoted-printable single part", () => {
    const parsed = parseHeaders(["Content-Transfer-Encoding: quoted-printable", "", "Meet at the caf=C3=A9."].join("\n"));
    expect(extractBody(parsed)).toBe("Meet at the café.");
  });
  it("multipart/alternative → prefers the text/plain part", () => {
    const raw = [
      "Content-Type: multipart/alternative; boundary=\"b1\"",
      "",
      "--b1",
      "Content-Type: text/plain",
      "",
      "Plain body here.",
      "--b1",
      "Content-Type: text/html",
      "",
      "<p>HTML <b>body</b></p>",
      "--b1--"
    ].join("\n");
    expect(extractBody(parseHeaders(raw))).toBe("Plain body here.");
  });
});

describe("ingestMbox", () => {
  it("turns each message into a markdown note with subject title, meta, decoded body", () => {
    const notes = ingestMbox(MBOX);
    expect(notes).toHaveLength(2);
    expect(notes[0]!.title).toBe("Lunch Tuesday");
    expect(notes[0]!.slug).toBe("lunch-tuesday");
    expect(notes[0]!.createdIso).toBe("2026-01-01T09:00:00.000Z");
    expect(notes[0]!.markdown).toContain("From: Alice <alice@x.com>");
    expect(notes[0]!.markdown).toContain("Let's do lunch Tuesday at noon.");
    expect(notes[1]!.title).toBe("Café plan"); // RFC-2047 decoded
    expect(notes[1]!.markdown).toContain("Meet at the café at 3pm."); // QP body decoded
  });

  it("looksLikeMbox detects the From-separator start; de-collides duplicate subjects", () => {
    expect(looksLikeMbox(MBOX)).toBe(true);
    expect(looksLikeMbox("{\"not\":\"mbox\"}")).toBe(false);
    const dup = ["From a@x Mon", "Subject: Re: ping", "", "one", "", "From b@x Tue", "Subject: Re: ping", "", "two"].join("\n");
    expect(ingestMbox(dup).map((n) => n.slug)).toEqual(["re-ping", "re-ping-2"]);
  });
});
