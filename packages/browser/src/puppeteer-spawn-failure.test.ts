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
});
