import { describe, expect, it } from "vitest";

import { parseMultipartBody, sseData } from "./server-multipart-sse.js";

// Direct coverage for the multipart parser + SSE line-framer (untested). The
// multipart parser is the chat-upload input boundary (separates text fields from
// files, base64-encodes file bytes); sseData must split CRLF/CR/LF so a bare CR
// in model output can't truncate the SSE stream client-side.

const buildBody = (boundary: string): Buffer => Buffer.from([
  `--${boundary}`, 'Content-Disposition: form-data; name="message"', "", "hello world", `--${boundary}`,
  'Content-Disposition: form-data; name="doc"; filename="a.txt"', "Content-Type: text/plain", "", "file body", `--${boundary}--`, ""
].join("\r\n"), "latin1");

describe("parseMultipartBody", () => {
  it("separates text fields from files and base64-encodes the file bytes", () => {
    const out = parseMultipartBody("multipart/form-data; boundary=X", buildBody("X"));
    expect(out.fields).toEqual({ message: "hello world" });
    const files = out.files as Array<Record<string, unknown>>;
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ contentType: "text/plain", fieldName: "doc", filename: "a.txt", size: 9 });
    expect(Buffer.from(files[0]?.contentBase64 as string, "base64").toString("utf8")).toBe("file body");
  });

  it("accepts a quoted boundary and a header-array content type", () => {
    expect(parseMultipartBody('multipart/form-data; boundary="X"', buildBody("X")).fields).toEqual({ message: "hello world" });
    expect(parseMultipartBody(["multipart/form-data; boundary=X"], buildBody("X")).fields).toEqual({ message: "hello world" });
  });

  it("throws when no boundary is present", () => {
    expect(() => parseMultipartBody("application/json", Buffer.from("x"))).toThrow(/boundary is required/u);
  });
});

describe("sseData", () => {
  it("splits CRLF / CR / LF each into a new data: segment", () => {
    expect(sseData("a\nb")).toBe("a\ndata: b");
    expect(sseData("a\r\nb")).toBe("a\ndata: b");
    expect(sseData("a\rb")).toBe("a\ndata: b");
  });

  it("emits a single space for an empty line so EventSource keeps the blank line", () => {
    expect(sseData("a\n\nb")).toBe("a\ndata:  \ndata: b");
  });
});

describe("toSseStream opening stage frame", () => {
  it("emits stage:thinking BEFORE the first runtime event, so the client shows life instantly", async () => {
    async function* slowRuntime(): AsyncIterable<{ type: "text-delta"; text: string; runId: string }> {
      yield { runId: "r", text: "hello", type: "text-delta" };
    }
    const { toSseStream } = await import("./server-multipart-sse.js");
    const frames: string[] = [];
    for await (const frame of toSseStream(slowRuntime() as never, "compat")) {
      frames.push(frame);
      if (frames.length >= 2) break;
    }
    expect(frames[0]).toContain("event: stage");
    expect(frames[0]).toContain("thinking");
    expect(frames[1]).toContain("event: message");
  });
});

describe("toSseStream live citation gate on forwarded deltas", () => {
  // The invariant this file exists to prove: a fabricated citation must not
  // reach a display EVEN over the new live-delta surface — the same clean
  // function the buffered gate uses runs over every in-flight [ … ] span,
  // and the spans it passes are exactly the spans the buffered gate keeps.
  async function* deltasWithFabrication(): AsyncIterable<
    | { type: "text-delta"; text: string; runId: string }
    | { type: "tool-result"; toolCall: { id: string; name: string; arguments: {} }; runId: string; grounding: { source: string; text: string } }
    | { type: "done"; runId: string; response: { output: string; model: string; usage: undefined } }
  > {
    yield { grounding: { source: "notes/real.md", text: "회의는 3시" }, runId: "r", toolCall: { arguments: {}, id: "t1", name: "knowledge_search" }, type: "tool-result" };
    yield { runId: "r", text: "회의는 3시야 [from ", type: "text-delta" };
    yield { runId: "r", text: "notes/real.md]. 그리고 예산은 ", type: "text-delta" };
    yield { runId: "r", text: "확정됐어 [from notes/ghost.md].", type: "text-delta" };
    yield { response: { model: "m", output: "", usage: undefined }, runId: "r", type: "done" };
  }

  it("passes a real citation through and DROPS a fabricated one mid-stream (span split across chunks)", async () => {
    const { toSseStream } = await import("./server-multipart-sse.js");
    const frames: string[] = [];
    for await (const frame of toSseStream(deltasWithFabrication() as never, "compat")) {
      frames.push(frame);
    }
    const streamedText = frames
      .filter((f) => f.startsWith("event: message"))
      .map((f) => f.split("data: ").slice(1).join("data: "))
      .join("");
    // The enforcer canonicalizes the ref to its basename — same as the buffered gate.
    expect(streamedText).toContain("[from real.md]");
    expect(streamedText).not.toContain("ghost.md");
  });

  it("the grounding frame stays authoritative over whatever streamed", async () => {
    const { toSseStream } = await import("./server-multipart-sse.js");
    const frames: string[] = [];
    for await (const frame of toSseStream(deltasWithFabrication() as never, "compat", { question: "회의 언제야?" })) {
      frames.push(frame);
    }
    const groundingFrame = frames.find((f) => f.startsWith("event: grounding"));
    expect(groundingFrame).toBeTruthy();
    const payload = JSON.parse(groundingFrame!.split("data: ")[1]!) as { answer: string; strippedCitations: string[] };
    // The fabricated source never reaches the answer — it appears ONLY in the
    // gate's own audit list of what it removed.
    expect(payload.answer).not.toContain("ghost.md");
    expect(payload.strippedCitations).toContain("notes/ghost.md");
  });
});
