import { enforceAnswerCitations } from "@muse/agent-core";
import { describe, expect, it } from "vitest";

import { createCitationStreamFilter } from "./citation-stream.js";

// A simple clean for the buffering tests: keep [from good.md], drop any other
// `[from …]`, and pass non-citation brackets through.
const stubClean = (span: string): string => {
  const m = /^\[from\s+(.+?)\]$/u.exec(span);
  if (m) return m[1] === "good.md" ? span : "";
  return span;
};

/** Run a whole string through the filter as ONE chunk. */
const whole = (clean: (s: string) => string, text: string): string => {
  const f = createCitationStreamFilter(clean);
  return f.push(text) + f.flush();
};

describe("createCitationStreamFilter — drop fabricated citations from a live stream", () => {
  it("passes plain text through untouched", () => {
    expect(whole(stubClean, "The MTU is 1380 and the office is on 5th Ave.")).toBe("The MTU is 1380 and the office is on 5th Ave.");
  });

  it("keeps a REAL citation and drops a FABRICATED one", () => {
    expect(whole(stubClean, "MTU 1380 [from good.md]")).toBe("MTU 1380 [from good.md]");
    expect(whole(stubClean, "MTU 1380 [from system.md]")).toBe("MTU 1380 ");
  });

  it("validates a citation SPLIT across stream chunks", () => {
    const f = createCitationStreamFilter(stubClean);
    let out = f.push("the answer [from ");   // holds the open bracket
    expect(out).toBe("the answer ");
    out += f.push("system.md] done");        // completes → fabricated → dropped
    out += f.flush();
    expect(out).toBe("the answer  done");
  });

  it("lets non-citation brackets through", () => {
    expect(whole(stubClean, "see item [1] and the list [a, b, c]")).toBe("see item [1] and the list [a, b, c]");
  });

  it("releases an unclosed '[' at stream end, and a bracket broken by a newline", () => {
    expect(whole(stubClean, "a trailing open [from goo")).toBe("a trailing open [from goo");
    expect(whole(stubClean, "line [not a cite\nnext line")).toBe("line [not a cite\nnext line");
  });

  it("works with the REAL enforceAnswerCitations (drops a note not in the allowed set)", () => {
    const clean = (span: string): string => enforceAnswerCitations(span, { notes: ["vpn.md"] }).text;
    expect(whole(clean, "MTU 1380 [from vpn.md].")).toBe("MTU 1380 [from vpn.md].");
    expect(whole(clean, "MTU 1380 [from system.md].")).toContain("MTU 1380");
    expect(whole(clean, "MTU 1380 [from system.md].")).not.toContain("system.md");
  });
});
