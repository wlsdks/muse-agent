import { describe, expect, it } from "vitest";

import { createWinClipboardSetTool, createWinSayTool } from "./windows-utility-tools.js";
import type { WinCommandResult } from "./windows-exec.js";

const ok: WinCommandResult = { exitCode: 0, stderr: "", stdout: "", timedOut: false };

function capture(): { runner: (s: string) => Promise<WinCommandResult>; scripts: string[] } {
  const scripts: string[] = [];
  return { runner: async (s: string) => { scripts.push(s); return ok; }, scripts };
}

describe("win_clipboard_set", () => {
  it("embeds the text base64 (never raw) into Set-Clipboard", async () => {
    const { runner, scripts } = capture();
    const out = await createWinClipboardSetTool({ runner }).execute({ text: `secret "quoted" $(rm)` }, { runId: "t" });
    expect(out).toMatchObject({ ok: true });
    expect(scripts[0]).toContain("Set-Clipboard");
    expect(scripts[0]).toContain("FromBase64String");
    expect(scripts[0]).not.toContain("secret");
  });

  it("refuses empty text without spawning", async () => {
    const { runner, scripts } = capture();
    const out = await createWinClipboardSetTool({ runner }).execute({ text: "   " }, { runId: "t" });
    expect(out).toMatchObject({ ok: false });
    expect(scripts).toHaveLength(0);
  });

  it("fail-softs on a runner throw", async () => {
    const out = await createWinClipboardSetTool({ runner: async () => { throw new Error("ENOENT"); } })
      .execute({ text: "x" }, { runId: "t" });
    expect(out).toMatchObject({ ok: false });
  });
});

describe("win_say", () => {
  it("builds a SpeechSynthesizer script with base64 text", async () => {
    const { runner, scripts } = capture();
    const out = await createWinSayTool({ runner }).execute({ text: "회의 10분 전이에요" }, { runId: "t" });
    expect(out).toMatchObject({ ok: true });
    expect(scripts[0]).toContain("SpeechSynthesizer");
    expect(scripts[0]).toContain("FromBase64String");
    expect(scripts[0]).not.toContain("회의");
  });

  it("caps runaway text and refuses empty text", async () => {
    const { runner, scripts } = capture();
    const tool = createWinSayTool({ runner });
    expect(await tool.execute({ text: "" }, { runId: "t" })).toMatchObject({ ok: false });
    expect(await tool.execute({ text: "a".repeat(2_001) }, { runId: "t" })).toMatchObject({ ok: false });
    expect(scripts).toHaveLength(0);
  });
});
