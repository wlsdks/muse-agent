import { describe, expect, it } from "vitest";

import { createWinMediaControlTool, WIN_MEDIA_ACTIONS } from "./windows-media-tool.js";
import { createWinSystemSetTool, WIN_SYSTEM_SETTINGS } from "./windows-system-set-tool.js";
import type { WinCommandResult } from "./windows-exec.js";

const ok: WinCommandResult = { exitCode: 0, stderr: "", stdout: "", timedOut: false };

function capture(): { runner: (s: string) => Promise<WinCommandResult>; scripts: string[] } {
  const scripts: string[] = [];
  return { runner: async (s: string) => { scripts.push(s); return ok; }, scripts };
}

describe("win_media_control", () => {
  it("declares the action enum", () => {
    const props = createWinMediaControlTool().definition.inputSchema.properties as Record<string, { enum?: readonly string[] }>;
    expect(props["action"]!.enum).toEqual([...WIN_MEDIA_ACTIONS]);
  });

  it("maps each action to its virtual key", async () => {
    for (const [action, vk] of [["playpause", "0xB3"], ["next", "0xB0"], ["previous", "0xB1"]] as const) {
      const { runner, scripts } = capture();
      const out = await createWinMediaControlTool({ runner }).execute({ action }, { runId: "t" });
      expect(out).toMatchObject({ action, ok: true });
      expect(scripts[0]).toContain("keybd_event");
      expect(scripts[0]).toContain(vk);
    }
  });

  it("refuses an unknown action without spawning; fail-softs on throw", async () => {
    const { runner, scripts } = capture();
    expect(await createWinMediaControlTool({ runner }).execute({ action: "stop" }, { runId: "t" })).toMatchObject({ ok: false });
    expect(scripts).toHaveLength(0);
    expect(await createWinMediaControlTool({ runner: async () => { throw new Error("ENOENT"); } })
      .execute({ action: "next" }, { runId: "t" })).toMatchObject({ ok: false });
  });
});

describe("win_system_set", () => {
  it("declares the setting enum", () => {
    const props = createWinSystemSetTool().definition.inputSchema.properties as Record<string, { enum?: readonly string[] }>;
    expect(props["setting"]!.enum).toEqual([...WIN_SYSTEM_SETTINGS]);
  });

  it("volume settings use key events; display_sleep broadcasts SC_MONITORPOWER", async () => {
    for (const [setting, marker] of [["volume_up", "0xAF"], ["volume_down", "0xAE"], ["mute", "0xAD"]] as const) {
      const { runner, scripts } = capture();
      const out = await createWinSystemSetTool({ runner }).execute({ setting }, { runId: "t" });
      expect(out).toMatchObject({ ok: true, setting });
      expect(scripts[0]).toContain(marker);
    }
    const { runner, scripts } = capture();
    const out = await createWinSystemSetTool({ runner }).execute({ setting: "display_sleep" }, { runId: "t" });
    expect(out).toMatchObject({ ok: true });
    expect(scripts[0]).toContain("0xf170");
    expect(scripts[0]).toContain("SendMessage");
  });

  it("refuses an unknown setting without spawning", async () => {
    const { runner, scripts } = capture();
    expect(await createWinSystemSetTool({ runner }).execute({ setting: "brightness" }, { runId: "t" })).toMatchObject({ ok: false });
    expect(scripts).toHaveLength(0);
  });
});
