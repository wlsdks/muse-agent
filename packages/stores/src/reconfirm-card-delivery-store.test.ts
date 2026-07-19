import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isReconfirmCardDeliveryRecent,
  markReconfirmCardDelivered,
  readReconfirmCardDelivery
} from "./reconfirm-card-delivery-store.js";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "reconfirm-card-delivery-"));
  file = join(dir, "reconfirm-card-delivery.json");
});

afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

describe("reconfirm-card-delivery-store", () => {
  it("reads undefined when the file does not exist", async () => {
    expect(await readReconfirmCardDelivery(file)).toBeUndefined();
  });

  it("records slotId + deliveredAt on mark, and reads it back", async () => {
    const at = new Date("2026-07-16T09:00:00.000Z");
    await markReconfirmCardDelivered(file, "pref-tone", at);
    expect(await readReconfirmCardDelivery(file)).toEqual({ deliveredAt: at.toISOString(), slotId: "pref-tone" });
  });

  it("overwrites the prior delivery — only the most recent is on record", async () => {
    await markReconfirmCardDelivered(file, "first", new Date("2026-07-15T09:00:00.000Z"));
    await markReconfirmCardDelivered(file, "second", new Date("2026-07-16T09:00:00.000Z"));
    expect(await readReconfirmCardDelivery(file)).toEqual({ deliveredAt: "2026-07-16T09:00:00.000Z", slotId: "second" });
  });

  it("tolerates malformed JSON — treated as never delivered", async () => {
    const { atomicWriteFile } = await import("./atomic-file-store.js");
    await atomicWriteFile(file, "not json");
    expect(await readReconfirmCardDelivery(file)).toBeUndefined();
  });

  it("tolerates a missing/malformed field shape", async () => {
    const { atomicWriteFile } = await import("./atomic-file-store.js");
    await atomicWriteFile(file, JSON.stringify({ slotId: "x" })); // no deliveredAt
    expect(await readReconfirmCardDelivery(file)).toBeUndefined();
    await atomicWriteFile(file, JSON.stringify({ deliveredAt: "not-a-date", slotId: "x" }));
    expect(await readReconfirmCardDelivery(file)).toBeUndefined();
    await atomicWriteFile(file, JSON.stringify({ deliveredAt: "2026-07-16T09:00:00.000Z", slotId: "" }));
    expect(await readReconfirmCardDelivery(file)).toBeUndefined();
  });
});

describe("isReconfirmCardDeliveryRecent", () => {
  const NOW = new Date("2026-07-16T09:00:00.000Z");

  it("undefined state is never recent", () => {
    expect(isReconfirmCardDeliveryRecent(undefined, NOW)).toBe(false);
  });

  it("a delivery within the default 24h window is recent", () => {
    const state = { deliveredAt: new Date(NOW.getTime() - 60_000).toISOString(), slotId: "s1" };
    expect(isReconfirmCardDeliveryRecent(state, NOW)).toBe(true);
  });

  it("a delivery exactly at the 24h boundary is still recent (inclusive)", () => {
    const state = { deliveredAt: new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString(), slotId: "s1" };
    expect(isReconfirmCardDeliveryRecent(state, NOW)).toBe(true);
  });

  it("a delivery older than 24h is NOT recent", () => {
    const state = { deliveredAt: new Date(NOW.getTime() - 24 * 60 * 60 * 1000 - 1).toISOString(), slotId: "s1" };
    expect(isReconfirmCardDeliveryRecent(state, NOW)).toBe(false);
  });

  it("a custom window overrides the default", () => {
    const state = { deliveredAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString(), slotId: "s1" };
    expect(isReconfirmCardDeliveryRecent(state, NOW, 60 * 60 * 1000)).toBe(false);
    expect(isReconfirmCardDeliveryRecent(state, NOW, 3 * 60 * 60 * 1000)).toBe(true);
  });

  it("an unparseable deliveredAt is never recent", () => {
    expect(isReconfirmCardDeliveryRecent({ deliveredAt: "garbage", slotId: "s1" }, NOW)).toBe(false);
  });
});
