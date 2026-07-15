import { mkdtempSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuthoredSkillStore } from "@muse/skills";
import { describe, expect, it } from "vitest";

import {
  isIdleForConsolidate,
  startConsolidateTick,
  type ConsolidateMergeOutcome
} from "./consolidate-tick.js";

const IDLE_MS = 30 * 60_000;
// Local-time 03:00 so getHours() === 3 regardless of the runner's timezone.
const NOW = new Date(2026, 4, 1, 3, 0, 0);

const readArchiveOrEmpty = async (dir: string): Promise<string[]> => {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
};

function baseOptions(overrides: Partial<Parameters<typeof startConsolidateTick>[0]> = {}): Parameters<typeof startConsolidateTick>[0] {
  return {
    authoredSkillsDir: "/tmp/unused",
    lastActivityMs: () => undefined,
    model: "qwen3:8b",
    modelProvider: { generate: async () => ({}) } as unknown as Parameters<typeof startConsolidateTick>[0]["modelProvider"],
    idleThresholdMs: IDLE_MS,
    now: () => NOW,
    runConsolidate: async () => [],
    ...overrides
  };
}

describe("isIdleForConsolidate", () => {
  it("is idle only with a stamp at least the threshold old; unknown activity is NOT idle", () => {
    const now = 1_000_000;
    expect(isIdleForConsolidate(now, undefined, IDLE_MS)).toBe(false);
    expect(isIdleForConsolidate(now, now - IDLE_MS, IDLE_MS)).toBe(true);
    expect(isIdleForConsolidate(now, now - IDLE_MS + 1, IDLE_MS)).toBe(false);
    expect(isIdleForConsolidate(now, now - 2 * IDLE_MS, IDLE_MS)).toBe(true);
  });
});

describe("startConsolidateTick.tickOnce — idle gate", () => {
  it("does NOT consolidate when the user is active (recent activity)", async () => {
    let calls = 0;
    const handle = startConsolidateTick(baseOptions({
      lastActivityMs: () => NOW.getTime() - 60_000, // 1 min ago — still active
      runConsolidate: async () => { calls += 1; return []; }
    }));
    await handle.tickOnce();
    handle.stop();
    expect(calls).toBe(0);
  });

  it("consolidates and logs each umbrella once idle past the threshold", async () => {
    const logs: string[] = [];
    const merged: readonly ConsolidateMergeOutcome[] = [{ umbrella: "email-handling", merged: ["draft-reply", "send-followup"] }];
    let calls = 0;
    const handle = startConsolidateTick(baseOptions({
      lastActivityMs: () => NOW.getTime() - IDLE_MS - 1, // just over the threshold
      logger: (m) => logs.push(m),
      runConsolidate: async () => { calls += 1; return merged; }
    }));
    await handle.tickOnce();
    handle.stop();
    expect(calls).toBe(1);
    expect(logs).toEqual(["consolidate-tick: folded 2 skills → email-handling"]);
  });

  it("skips during quiet hours even when idle", async () => {
    let calls = 0;
    const handle = startConsolidateTick(baseOptions({
      lastActivityMs: () => NOW.getTime() - IDLE_MS - 1,
      quietHours: { startHour: 0, endHour: 6 }, // 03:00Z is inside
      runConsolidate: async () => { calls += 1; return []; }
    }));
    await handle.tickOnce();
    handle.stop();
    expect(calls).toBe(0);
  });

  it("never throws when the consolidate run fails — routes to errorLogger", async () => {
    const errors: string[] = [];
    const handle = startConsolidateTick(baseOptions({
      lastActivityMs: () => NOW.getTime() - IDLE_MS - 1,
      errorLogger: (m) => errors.push(m),
      runConsolidate: async () => { throw new Error("merge boom"); }
    }));
    await expect(handle.tickOnce()).resolves.toBeUndefined();
    handle.stop();
    expect(errors).toEqual(["consolidate-tick: merge boom"]);
  });
});

describe("startConsolidateTick.tickOnce — REAL OS-idle brake (B1 brake-first)", () => {
  // API-idle holds in all three; only the OS-idle probe varies.
  const apiIdle = { lastActivityMs: () => NOW.getTime() - IDLE_MS - 1 };

  it("does NOT consolidate when the OS is busy, even though Muse's /api is quiet", async () => {
    let calls = 0;
    const handle = startConsolidateTick(baseOptions({
      ...apiIdle,
      osIdleMs: () => 60_000, // OS idle only 1 min < 30 min threshold → busy in another app
      runConsolidate: async () => { calls += 1; return []; }
    }));
    await handle.tickOnce();
    handle.stop();
    expect(calls).toBe(0);
  });

  it("does NOT consolidate when the OS-idle probe is unknown (fail-closed)", async () => {
    let calls = 0;
    const handle = startConsolidateTick(baseOptions({
      ...apiIdle,
      osIdleMs: () => undefined, // probe failed / non-macOS → never run unattended
      runConsolidate: async () => { calls += 1; return []; }
    }));
    await handle.tickOnce();
    handle.stop();
    expect(calls).toBe(0);
  });

  it("consolidates when BOTH Muse /api AND the OS are idle past the threshold", async () => {
    let calls = 0;
    const handle = startConsolidateTick(baseOptions({
      ...apiIdle,
      osIdleMs: () => IDLE_MS + 1,
      runConsolidate: async () => { calls += 1; return []; }
    }));
    await handle.tickOnce();
    handle.stop();
    expect(calls).toBe(1);
  });
});

describe("startConsolidateTick.tickOnce — model-resident brake (never cold-load unattended)", () => {
  const idle = { lastActivityMs: () => NOW.getTime() - IDLE_MS - 1 };

  it("does NOT consolidate when the model is not resident (would cold-load)", async () => {
    let calls = 0;
    const handle = startConsolidateTick(baseOptions({
      ...idle,
      isModelResident: async () => false,
      runConsolidate: async () => { calls += 1; return []; }
    }));
    await handle.tickOnce();
    handle.stop();
    expect(calls).toBe(0);
  });

  it("consolidates when idle AND the model is already resident", async () => {
    let calls = 0;
    const handle = startConsolidateTick(baseOptions({
      ...idle,
      isModelResident: async () => true,
      runConsolidate: async () => { calls += 1; return []; }
    }));
    await handle.tickOnce();
    handle.stop();
    expect(calls).toBe(1);
  });
});

describe("startConsolidateTick.tickOnce — AC-power brake (never drain the battery)", () => {
  const idle = { lastActivityMs: () => NOW.getTime() - IDLE_MS - 1 };

  it("does NOT consolidate on battery, even when idle", async () => {
    let calls = 0;
    const handle = startConsolidateTick(baseOptions({
      ...idle,
      isOnAcPower: () => false,
      runConsolidate: async () => { calls += 1; return []; }
    }));
    await handle.tickOnce();
    handle.stop();
    expect(calls).toBe(0);
  });

  it("does NOT consolidate when power is unknown (fail-closed)", async () => {
    let calls = 0;
    const handle = startConsolidateTick(baseOptions({
      ...idle,
      isOnAcPower: () => undefined,
      runConsolidate: async () => { calls += 1; return []; }
    }));
    await handle.tickOnce();
    handle.stop();
    expect(calls).toBe(0);
  });

  it("consolidates when idle AND on AC power", async () => {
    let calls = 0;
    const handle = startConsolidateTick(baseOptions({
      ...idle,
      isOnAcPower: () => true,
      runConsolidate: async () => { calls += 1; return []; }
    }));
    await handle.tickOnce();
    handle.stop();
    expect(calls).toBe(1);
  });
});

describe("startConsolidateTick.tickOnce — Ollama lease brake (defer to foreground)", () => {
  const idle = { lastActivityMs: () => NOW.getTime() - IDLE_MS - 1 };

  it("does NOT consolidate while a foreground call holds the lease", async () => {
    let calls = 0;
    const handle = startConsolidateTick(baseOptions({
      ...idle,
      isForegroundBusy: () => true,
      runConsolidate: async () => { calls += 1; return []; }
    }));
    await handle.tickOnce();
    handle.stop();
    expect(calls).toBe(0);
  });

  it("consolidates when idle AND no foreground call is using Ollama", async () => {
    let calls = 0;
    const handle = startConsolidateTick(baseOptions({
      ...idle,
      isForegroundBusy: () => false,
      runConsolidate: async () => { calls += 1; return []; }
    }));
    await handle.tickOnce();
    handle.stop();
    expect(calls).toBe(1);
  });
});

describe("startConsolidateTick.tickOnce — idle distill phase runs behind the brakes", () => {
  it("calls distillQueued when idle, NOT when a brake blocks", async () => {
    let distillCalls = 0;
    const idleOpts = (over = {}) => baseOptions({
      lastActivityMs: () => NOW.getTime() - IDLE_MS - 1,
      distillQueued: async () => { distillCalls += 1; return 1; },
      ...over
    });
    // blocked by a brake (battery) → distill NOT called
    let h = startConsolidateTick(idleOpts({ isOnAcPower: () => false }));
    await h.tickOnce(); h.stop();
    expect(distillCalls).toBe(0);
    // gates pass → distill runs
    h = startConsolidateTick(idleOpts({ isOnAcPower: () => true }));
    await h.tickOnce(); h.stop();
    expect(distillCalls).toBe(1);
  });
});

describe("startConsolidateTick.tickOnce — idle disuse-decay phase runs behind the brakes (B1 Slice 2)", () => {
  it("calls decayStale when idle, NOT when a brake blocks", async () => {
    let decayCalls = 0;
    const idleOpts = (over = {}) => baseOptions({
      lastActivityMs: () => NOW.getTime() - IDLE_MS - 1,
      decayStale: async () => { decayCalls += 1; return 2; },
      ...over
    });
    // blocked by a brake (battery) → decay NOT called
    let h = startConsolidateTick(idleOpts({ isOnAcPower: () => false }));
    await h.tickOnce(); h.stop();
    expect(decayCalls).toBe(0);
    // gates pass → decay runs
    h = startConsolidateTick(idleOpts({ isOnAcPower: () => true }));
    await h.tickOnce(); h.stop();
    expect(decayCalls).toBe(1);
  });
});

describe("startConsolidateTick.tickOnce — held-out gate on the REAL default path (SkillOpt propose-and-test)", () => {
  function merger(output: string) {
    return { generate: async () => ({ output }) } as unknown as Parameters<typeof startConsolidateTick>[0]["modelProvider"];
  }

  // Topic-vector fake embedder over [email, document] axes — cosine reflects
  // which topics a text covers, so a single-topic umbrella misses the other.
  function fakeEmbed(text: string): Promise<readonly number[]> {
    const t = text.toLowerCase();
    const v = [/email/u.test(t) ? 1 : 0, /doc|document/u.test(t) ? 1 : 0];
    return Promise.resolve(v[0] === 0 && v[1] === 0 ? [0.5, 0.5] : v);
  }

  async function seedTwoSummariseSkills(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "muse-consolidate-tick-"));
    const store = new AuthoredSkillStore({ dir });
    await store.writeOrPatch({ name: "summarise-email", description: "Use when summarising an email thread", body: "read; bullets" });
    await store.writeOrPatch({ name: "summarise-doc", description: "Use when summarising a document", body: "skim; bullets" });
    return dir;
  }

  it("cooldown: a cluster the gate keeps rejecting stops being merged after the threshold (across ticks)", async () => {
    const dir = await seedTwoSummariseSkills();
    const ledger = join(dir, ".reject-cooldown.json");
    let generateCalls = 0;
    const counting = {
      generate: async () => { generateCalls += 1; return { output: "name: summarise-email-only\ndescription: Use when summarising an email thread\nbody: 1. read the email" }; }
    } as unknown as Parameters<typeof startConsolidateTick>[0]["modelProvider"];
    const opts = baseOptions({
      authoredSkillsDir: dir,
      lastActivityMs: () => NOW.getTime() - IDLE_MS - 1,
      threshold: 0.3,
      runConsolidate: undefined,
      embed: fakeEmbed,
      rejectLedgerFile: ledger,
      cooldownThreshold: 2,
      modelProvider: counting
    });
    const handle = startConsolidateTick(opts);
    await handle.tickOnce(); // reject #1 (merge+retry called)
    const afterTick1 = generateCalls;
    await handle.tickOnce(); // reject #2 → count reaches threshold
    const afterTick2 = generateCalls;
    await handle.tickOnce(); // now cooled down → merge must NOT be called
    handle.stop();
    expect(afterTick1).toBeGreaterThan(0); // merged on tick 1
    expect(afterTick2).toBeGreaterThan(afterTick1); // merged again on tick 2
    expect(generateCalls).toBe(afterTick2); // tick 3 skipped the cluster (no new merge call)
  });

  it("rejects a coverage-losing umbrella: originals stay live, nothing archived, rejection logged", async () => {
    const dir = await seedTwoSummariseSkills();
    const logs: string[] = [];
    // Merger drops the "document" skill — keeps only the email trigger.
    const handle = startConsolidateTick(baseOptions({
      authoredSkillsDir: dir,
      lastActivityMs: () => NOW.getTime() - IDLE_MS - 1,
      threshold: 0.3,
      runConsolidate: undefined,
      embed: fakeEmbed,
      logger: (m) => logs.push(m),
      modelProvider: merger("name: summarise-email-only\ndescription: Use when summarising an email thread\nbody:\n1. read the email\n2. emit bullets")
    }));
    await handle.tickOnce();
    handle.stop();

    const store = new AuthoredSkillStore({ dir });
    const live = (await store.listAuthored()).map((s) => s.name).sort();
    expect(live).toEqual(["summarise-doc", "summarise-email"]); // both intact (rollback)
    const archived = await readArchiveOrEmpty(join(dir, ".archive"));
    expect(archived).toEqual([]); // nothing archived
    expect(logs.some((m) => m.includes("held-out gate rejected"))).toBe(true);
  });

  it("feedbackRetry end-to-end: a rejected first umbrella is re-proposed with feedback and the steered umbrella commits", async () => {
    const dir = await seedTwoSummariseSkills();
    const logs: string[] = [];
    // Feedback-aware merger: without the DROPPED steer line it proposes an
    // email-only umbrella (drops the doc skill); with it, a covering umbrella.
    const merger = {
      generate: async (req: { messages: { role: string; content: string }[] }) => {
        const user = req.messages.find((m) => m.role === "user")?.content ?? "";
        return {
          output: /DROPPED/u.test(user)
            ? "name: summarise-text\ndescription: Use when summarising an email thread or a document\nbody:\n1. read 2. bullets"
            : "name: summarise-email-only\ndescription: Use when summarising an email thread\nbody:\n1. read the email"
        };
      }
    } as unknown as Parameters<typeof startConsolidateTick>[0]["modelProvider"];
    const handle = startConsolidateTick(baseOptions({
      authoredSkillsDir: dir,
      lastActivityMs: () => NOW.getTime() - IDLE_MS - 1,
      threshold: 0.3,
      runConsolidate: undefined,
      embed: fakeEmbed,
      logger: (m) => logs.push(m),
      modelProvider: merger
    }));
    await handle.tickOnce();
    handle.stop();

    const store = new AuthoredSkillStore({ dir });
    const live = (await store.listAuthored()).map((s) => s.name);
    expect(live).toContain("summarise-text"); // the steered re-proposal committed
    expect(live).not.toContain("summarise-email");
    expect(logs.some((m) => m.includes("held-out gate rejected"))).toBe(true); // attempt 1 was rejected
    expect(logs.some((m) => m.includes("folded 2 skills"))).toBe(true); // attempt 2 committed
  });

  it("commits a coverage-preserving umbrella: originals archived, umbrella written", async () => {
    const dir = await seedTwoSummariseSkills();
    const logs: string[] = [];
    // Merger keeps BOTH triggers (email + document).
    const handle = startConsolidateTick(baseOptions({
      authoredSkillsDir: dir,
      lastActivityMs: () => NOW.getTime() - IDLE_MS - 1,
      threshold: 0.3,
      runConsolidate: undefined,
      embed: fakeEmbed,
      logger: (m) => logs.push(m),
      modelProvider: merger("name: summarise-text\ndescription: Use when summarising an email thread or a document\nbody:\n1. read the email or document\n2. emit bullets")
    }));
    await handle.tickOnce();
    handle.stop();

    const store = new AuthoredSkillStore({ dir });
    const live = (await store.listAuthored()).map((s) => s.name);
    expect(live).toContain("summarise-text");
    expect(live).not.toContain("summarise-email");
    expect(logs.some((m) => m.includes("folded 2 skills"))).toBe(true);
  });
});

describe("startConsolidateTick.tickOnce — curate phase (stale skill auto-archive)", () => {
  it("runs curate when idle past the threshold and logs the archived count", async () => {
    let curated = 0;
    const logs: string[] = [];
    const handle = startConsolidateTick(baseOptions({
      lastActivityMs: () => NOW.getTime() - IDLE_MS - 1,
      curateMaxIdleDays: 90,
      runCurate: async () => { curated += 1; return ["stale-a", "stale-b"]; },
      logger: (m) => logs.push(m)
    }));
    await handle.tickOnce();
    expect(curated).toBe(1);
    expect(logs.some((m) => m.includes("archived 2 stale skill"))).toBe(true);
  });

  it("does NOT curate when the user is still active", async () => {
    let curated = 0;
    const handle = startConsolidateTick(baseOptions({
      lastActivityMs: () => NOW.getTime() - 60_000,
      curateMaxIdleDays: 90,
      runCurate: async () => { curated += 1; return []; }
    }));
    await handle.tickOnce();
    expect(curated).toBe(0);
  });

  it("curates EVEN when the model is cold — curate runs before the LLM brakes", async () => {
    let curated = 0;
    let consolidated = 0;
    const handle = startConsolidateTick(baseOptions({
      lastActivityMs: () => NOW.getTime() - IDLE_MS - 1,
      curateMaxIdleDays: 90,
      isModelResident: () => false, // LLM brake: blocks consolidate
      runCurate: async () => { curated += 1; return ["stale"]; },
      runConsolidate: async () => { consolidated += 1; return []; }
    }));
    await handle.tickOnce();
    expect(curated).toBe(1); // curate ran (model-free, before the brake)
    expect(consolidated).toBe(0); // consolidate deferred by the cold-model brake
  });

  it("skips the curate phase when curateMaxIdleDays is absent", async () => {
    let curated = 0;
    const handle = startConsolidateTick(baseOptions({
      lastActivityMs: () => NOW.getTime() - IDLE_MS - 1,
      runCurate: async () => { curated += 1; return []; }
    }));
    await handle.tickOnce();
    expect(curated).toBe(0);
  });
});
