/**
 * `risk` is what selects the approval gate, so a Windows tool one tier below its
 * macOS twin means the SAME action — take a screenshot, overwrite the clipboard,
 * change a system setting — is gated more weakly purely because of the host.
 * All five were `write` against macOS's `execute` until this test existed.
 *
 * It lives here, not in @muse/windows, because the comparison needs both
 * platform packages and neither should depend on the other.
 */

import { describe, expect, it } from "vitest";

import {
  createMacAppOpenTool,
  createMacAppReadTool,
  createMacClipboardSetTool,
  createMacMediaControlTool,
  createMacSayTool,
  createMacScreenshotTool,
  createMacSystemSetTool
} from "@muse/macos";
import {
  createWinAppOpenTool,
  createWinAppReadTool,
  createWinClipboardSetTool,
  createWinMediaControlTool,
  createWinSayTool,
  createWinScreenshotTool,
  createWinSystemSetTool
} from "@muse/windows";

const TWINS = [
  ["screenshot", createWinScreenshotTool, createMacScreenshotTool],
  ["clipboard_set", createWinClipboardSetTool, createMacClipboardSetTool],
  ["say", createWinSayTool, createMacSayTool],
  ["media_control", createWinMediaControlTool, createMacMediaControlTool],
  ["system_set", createWinSystemSetTool, createMacSystemSetTool],
  ["app_open", createWinAppOpenTool, createMacAppOpenTool],
  ["app_read", createWinAppReadTool, createMacAppReadTool]
] as const;

describe("Windows actuators are gated exactly as strictly as their macOS twins", () => {
  for (const [verb, win, mac] of TWINS) {
    it(`win_${verb} carries the same risk tier as mac_${verb}`, () => {
      expect(win().definition.risk).toBe(mac().definition.risk);
    });
  }
});
