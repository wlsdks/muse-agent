import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  adoptChannelOwner,
  getOrCreatePairingCode,
  readChannelOwner,
  verifyPairingCodeAttempt
} from "./channel-owner-store.js";

let directory: string | undefined;

afterEach(async () => {
  if (directory !== undefined) {
    await rm(directory, { force: true, recursive: true });
    directory = undefined;
  }
});

describe("channel owner pairing persistence", () => {
  it("adopts exactly one first owner when daemon ticks race", async () => {
    directory = await mkdtemp(join(tmpdir(), "muse-channel-owner-"));
    const file = join(directory, "owners.json");

    const results = await Promise.all([
      adoptChannelOwner(file, "telegram", "chat-a"),
      adoptChannelOwner(file, "telegram", "chat-b")
    ]);

    const owner = await readChannelOwner(file, "telegram");
    expect(owner).toBeDefined();
    expect(new Set(results)).toEqual(new Set([owner]));
  });

  it("consumes a matching pairing code exactly once under concurrent delivery", async () => {
    directory = await mkdtemp(join(tmpdir(), "muse-pairing-code-"));
    const file = join(directory, "codes.json");
    const code = await getOrCreatePairingCode(file, "telegram", new Date("2026-07-16T00:00:00.000Z"));

    const verdicts = await Promise.all([
      verifyPairingCodeAttempt(file, "telegram", code),
      verifyPairingCodeAttempt(file, "telegram", code)
    ]);

    expect(verdicts.filter((verdict) => verdict === "matched")).toHaveLength(1);
    expect(verdicts.filter((verdict) => verdict === "no_code")).toHaveLength(1);
  });
});
