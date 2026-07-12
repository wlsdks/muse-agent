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
