import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readCheckins, scheduleCheckins, writeCheckins } from "@muse/proactivity";
import { afterEach, describe, expect, it } from "vitest";

import { scanSessionCheckins } from "../src/commands-checkins.js";

// Deterministic embedder (no Ollama): the discharge turn shares the commitment's
// content tokens → high cosine; an unrelated turn → 0.
const VOCAB = ["email", "bob", "report", "dentist", "appointment"] as const;
const stubEmbed = async (text: string): Promise<readonly number[]> => {
  const lower = text.toLowerCase();
  return VOCAB.map((w) => (lower.includes(w) ? 1 : 0));
};

describe("scanSessionCheckins — cross-session auto-discharge (π-Bench arXiv:2605.14678)", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("cancels a STANDING scheduled check-in when the user reports it done in a NEW session", async () => {
    dir = await mkdtemp(join(tmpdir(), "muse-checkin-discharge-"));
    const file = join(dir, "checkins.json");
    // session 1 left a standing check-in for an open loop
    const seeded = scheduleCheckins(["email Bob the report"], { existing: [], now: new Date("2026-06-01T00:00:00Z"), userId: "u1" });
    await writeCheckins(file, seeded);
    expect(seeded.length).toBe(1);
    expect((await readCheckins(file)).every((c) => c.status === "scheduled")).toBe(true);

    // session 2 (a later process): the user reports doing it
    await scanSessionCheckins({
      file,
      userId: "u1",
      readHistory: async () => [{ content: "done, I emailed Bob the report this morning", role: "user" }],
      embed: stubEmbed,
      now: () => new Date("2026-06-05T00:00:00Z")
    });

    const after = await readCheckins(file);
    expect(after.find((c) => c.commitment === "email Bob the report")?.status).toBe("cancelled");
  });

  it("leaves the check-in scheduled when the new session has only an UNRELATED discharge", async () => {
    dir = await mkdtemp(join(tmpdir(), "muse-checkin-keep-"));
    const file = join(dir, "checkins.json");
    await writeCheckins(file, scheduleCheckins(["email Bob the report"], { existing: [], now: new Date("2026-06-01T00:00:00Z"), userId: "u1" }));

    await scanSessionCheckins({
      file,
      userId: "u1",
      readHistory: async () => [{ content: "finished — called the dentist about my appointment", role: "user" }],
      embed: stubEmbed,
      now: () => new Date("2026-06-05T00:00:00Z")
    });

    expect((await readCheckins(file)).find((c) => c.commitment === "email Bob the report")?.status).toBe("scheduled");
  });
});
