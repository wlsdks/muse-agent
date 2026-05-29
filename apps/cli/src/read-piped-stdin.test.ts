import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { readPipedStdin } from "./chat-repl.js";

type FakeStdin = PassThrough & { isTTY?: boolean };

describe("readPipedStdin — never blocks on a non-EOF stdin", () => {
  it("returns '' immediately for a TTY (interactive shell)", async () => {
    const s = new PassThrough() as FakeStdin;
    s.isTTY = true;
    expect(await readPipedStdin({ stream: s })).toBe("");
  });

  it("reads full piped content to EOF (the `cat f | muse ask` idiom)", async () => {
    const s = new PassThrough() as FakeStdin;
    const p = readPipedStdin({ stream: s });
    s.write("hello ");
    s.write("piped world");
    s.end();
    expect(await p).toBe("hello piped world");
  });

  it("does NOT truncate large input that arrives after the first-byte window", async () => {
    const s = new PassThrough() as FakeStdin;
    const p = readPipedStdin({ firstByteTimeoutMs: 30, stream: s });
    s.write("chunk-1 "); // first byte well within the window
    await new Promise((r) => setTimeout(r, 60)); // ... then more arrives LATER
    s.write("chunk-2");
    s.end();
    expect(await p).toBe("chunk-1 chunk-2");
  });

  it("returns '' when a non-TTY stdin never sends data AND never EOFs (the stall bug)", async () => {
    const s = new PassThrough() as FakeStdin; // open, silent, never .end()
    const t0 = Date.now();
    const out = await readPipedStdin({ firstByteTimeoutMs: 40, stream: s });
    expect(out).toBe("");
    expect(Date.now() - t0).toBeLessThan(500); // bailed fast, did not hang
  });

  it("returns '' for an empty redirect (`muse ask < /dev/null`)", async () => {
    const s = new PassThrough() as FakeStdin;
    const p = readPipedStdin({ stream: s });
    s.end(); // immediate EOF, no data
    expect(await p).toBe("");
  });
});
