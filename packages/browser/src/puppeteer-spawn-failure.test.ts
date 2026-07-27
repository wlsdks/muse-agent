/**
 * A DETACHED spawn reports a bad executable asynchronously, via an 'error'
 * event that `spawn` never throws. With no listener attached Node treats it as
 * an unhandled 'error' and terminates the WHOLE process — so a missing or
 * misconfigured Chrome killed Muse itself, not just the browser tool. That is
 * strictly worse than a thrown error: nothing downstream gets a chance to
 * report it, and the user sees the assistant vanish mid-turn.
 */

import { describe, expect, it } from "vitest";

import { PuppeteerBrowserController } from "./puppeteer-controller.js";

describe("a Chrome that cannot be launched", () => {
  it("surfaces as a rejected call, not a dead process", async () => {
    const controller = new PuppeteerBrowserController({ executablePath: "/nonexistent/muse-test-chrome" });

    // Reaching the assertion at all is most of the point: before the 'error'
    // listener existed, this line was never reached because the runner died.
    await expect(controller.snapshot()).rejects.toThrow(/could not be started/iu);
  });

  it("names the executable it tried and how to point it somewhere else", async () => {
    const controller = new PuppeteerBrowserController({ executablePath: "/nonexistent/muse-test-chrome" });

    await expect(controller.snapshot()).rejects.toThrow(/MUSE_CHROME_PATH/u);
    await expect(controller.snapshot()).rejects.toThrow(/nonexistent\/muse-test-chrome/u);
  });

  it("bounds cleanup of the exact child when the opt-in receipt callback rejects", async () => {
    if (process.platform === "win32") return;
    let launchedPid: number | undefined;
    const controller = new PuppeteerBrowserController({
      executablePath: "/usr/bin/yes",
      onDetachedLaunch: (receipt) => {
        launchedPid = receipt.pid;
        throw new Error("qualification registry rejected");
      }
    });

    await expect(controller.snapshot()).rejects.toThrow(/ownership receipt was rejected/iu);
    expect(launchedPid).toBeTypeOf("number");
    const exactPid = launchedPid;
    if (exactPid === undefined) throw new Error("launch callback did not receive a pid");
    expect(() => process.kill(exactPid, 0)).toThrow(
      expect.objectContaining({ code: "ESRCH" })
    );
  });
});
