import { describe, expect, it } from "vitest";

import { parseWindowsActiveWindow, WindowsActiveWindowSource } from "../src/windows-ambient-source.js";

describe("parseWindowsActiveWindow", () => {
  it("parses process + window title", () => {
    expect(parseWindowsActiveWindow("chrome\nQ3 memo - Google Docs\n")).toEqual({ app: "chrome", window: "Q3 memo - Google Docs" });
  });

  it("app-only when the title line is empty", () => {
    expect(parseWindowsActiveWindow("explorer\n\n")).toEqual({ app: "explorer" });
  });

  it("undefined on empty output or undefined stdout", () => {
    expect(parseWindowsActiveWindow("")).toBeUndefined();
    expect(parseWindowsActiveWindow("\n\n")).toBeUndefined();
    expect(parseWindowsActiveWindow(undefined)).toBeUndefined();
  });
});

describe("WindowsActiveWindowSource", () => {
  it("snapshots via the injected runner", async () => {
    const source = new WindowsActiveWindowSource({ run: async () => "code\nagent-runtime.ts — muse\n" });
    expect(await source.snapshot()).toEqual({ app: "code", window: "agent-runtime.ts — muse" });
  });

  it("a throwing runner yields undefined (fail-open, never throws)", async () => {
    const source = new WindowsActiveWindowSource({ run: async () => { throw new Error("spawn failed"); } });
    expect(await source.snapshot()).toBeUndefined();
  });

  it("clipboard rides the signal only when opted in, capped", async () => {
    const off = new WindowsActiveWindowSource({
      readClipboard: async () => "copied text",
      run: async () => "word\ndoc.docx\n"
    });
    expect(await off.snapshot()).toEqual({ app: "word", window: "doc.docx" });

    const on = new WindowsActiveWindowSource({
      includeClipboard: true,
      maxClipboardChars: 6,
      readClipboard: async () => "copied text",
      run: async () => "word\ndoc.docx\n"
    });
    expect(await on.snapshot()).toEqual({ app: "word", clipboard: "copied", window: "doc.docx" });
  });
});

describe.skipIf(process.platform !== "win32")("real PowerShell foreground snapshot (windows-latest contract)", () => {
  it("snapshots the real foreground state without throwing", async () => {
    const signal = await new WindowsActiveWindowSource().snapshot();
    expect(signal === undefined || typeof signal.app === "string").toBe(true);
  }, 60_000);
});
