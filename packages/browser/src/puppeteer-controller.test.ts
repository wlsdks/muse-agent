import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page } from "puppeteer-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { normalizeBrowserTimeout, PuppeteerBrowserController } from "./puppeteer-controller.js";

describe("normalizeBrowserTimeout", () => {
  it("falls back for invalid timer values and clamps Node timer overflow", () => {
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(normalizeBrowserTimeout(value, 15_000)).toBe(15_000);
    }
    expect(normalizeBrowserTimeout(Number.MAX_SAFE_INTEGER, 15_000)).toBe(2_147_483_647);
  });
});

describe("hasOpenPage — never launches a browser to answer", () => {
  let scratchDir: string | undefined;

  afterEach(async () => {
    if (scratchDir) await rm(scratchDir, { force: true, recursive: true });
    scratchDir = undefined;
  });

  it("reports false when no Chrome is reachable, without spawning one", async () => {
    // A fresh profile dir has no DevToolsActivePort file, so connectToExisting
    // fails fast (readFile ENOENT, caught) — hasOpenPage must return false
    // from THAT path alone, never fall through to launchDetached.
    scratchDir = await mkdtemp(join(tmpdir(), "muse-browser-test-"));
    const controller = new PuppeteerBrowserController({ userDataDir: scratchDir });
    await expect(controller.hasOpenPage()).resolves.toBe(false);
  });
});

describe("snapshot dialog evidence", () => {
  it("survives an unsettled first capture and is consumed after the final observation", async () => {
    const events = new EventEmitter();
    let capture = 0;
    const page = Object.assign(events, {
      evaluate: vi.fn(async (_fn: unknown, ...args: unknown[]) => {
        if (args.length === 0) {
          return capture === 0
            ? ""
            : "Navigation completed with enough terminal text to be settled.";
        }
        capture += 1;
        return [];
      }),
      isClosed: () => false,
      title: vi.fn(async () => "AFTER-UNLOAD"),
      url: () => "https://example.test/after"
    }) as unknown as Page;
    const controller = new PuppeteerBrowserController();
    Object.assign(controller, {
      lastDialog: { message: "", type: "beforeunload" },
      page
    });

    const observed = await controller.snapshot();
    expect(observed.dialog).toEqual({ message: "", type: "beforeunload" });
    expect(capture).toBe(2);

    await expect(controller.snapshot()).resolves.not.toHaveProperty("dialog");
  });
});
