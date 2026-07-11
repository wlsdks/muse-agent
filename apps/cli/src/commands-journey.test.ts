import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerJourneyCommands } from "./commands-journey.js";

type IO = Parameters<typeof registerJourneyCommands>[1];

function findSub(program: Command, names: readonly string[]): Command | undefined {
  let current: Command | undefined = program;
  for (const name of names) {
    current = current?.commands.find((command) => command.name() === name);
  }
  return current;
}

async function run(args: readonly string[]): Promise<{ readonly out: string; readonly err: string; readonly exitCode: number | undefined }> {
  const out: string[] = [];
  const err: string[] = [];
  const io = { stderr: (m: string) => err.push(m), stdout: (m: string) => out.push(m) } as unknown as IO;
  const program = new Command();
  program.exitOverride();
  registerJourneyCommands(program, io);
  let exitCode: number | undefined;
  try {
    await program.parseAsync(["node", "x", "journey", ...args], { from: "node" });
  } catch (cause) {
    exitCode = (cause as { exitCode?: number }).exitCode ?? 1;
  }
  return { err: err.join(""), exitCode, out: out.join("") };
}

describe("muse journey command registration", () => {
  it("registers the journey group with --kind/--since/--limit/--json and a forget subcommand", () => {
    const program = new Command();
    registerJourneyCommands(program, { stderr: () => undefined, stdout: () => undefined } as unknown as IO);
    const journey = findSub(program, ["journey"]);
    expect(journey).toBeDefined();
    const optionFlags = (journey?.options ?? []).map((o) => o.long);
    expect(optionFlags).toEqual(expect.arrayContaining(["--kind", "--since", "--limit", "--json", "--user"]));
    expect(findSub(program, ["journey", "forget"])).toBeDefined();
  });
});

describe("muse journey — merged timeline over real file stores", () => {
  let dir = "";
  let prevHome: string | undefined;
  let prevPlaybook: string | undefined;
  let prevProvenance: string | undefined;
  let prevSkillsDir: string | undefined;
  let prevUserId: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "muse-journey-"));
    prevHome = process.env.HOME;
    prevPlaybook = process.env.MUSE_PLAYBOOK_FILE;
    prevProvenance = process.env.MUSE_BELIEF_PROVENANCE_FILE;
    prevSkillsDir = process.env.MUSE_AUTHORED_SKILLS_DIR;
    prevUserId = process.env.MUSE_USER_ID;
    process.env.HOME = dir;
    process.env.MUSE_PLAYBOOK_FILE = join(dir, "playbook.json");
    process.env.MUSE_BELIEF_PROVENANCE_FILE = join(dir, "belief-provenance.json");
    process.env.MUSE_AUTHORED_SKILLS_DIR = join(dir, "skills", "authored");
    process.env.MUSE_USER_ID = "journey-user";

    const { recordPlaybookStrategy } = await import("@muse/stores");
    await recordPlaybookStrategy(process.env.MUSE_PLAYBOOK_FILE, {
      createdAt: "2026-01-10T00:00:00.000Z",
      id: "pb_journeytest01",
      lastReinforcedAt: "2026-02-05T00:00:00.000Z",
      text: "keep replies under 4 sentences",
      userId: "journey-user"
    });

    const { FileBeliefProvenanceStore, FileUserMemoryStore } = await import("@muse/memory");
    const provenanceStore = new FileBeliefProvenanceStore(process.env.MUSE_BELIEF_PROVENANCE_FILE);
    await provenanceStore.recordMany([
      { key: "home_city", kind: "fact", learnedAt: "2026-01-01T00:00:00.000Z", source: "user", userId: "journey-user", value: "Busan" },
      { key: "home_city", kind: "fact", learnedAt: "2026-01-20T00:00:00.000Z", source: "user", userId: "journey-user", value: "Seoul" }
    ]);
    // Real product flow (`memory set --local` / auto-extract) writes BOTH the
    // current-value store AND the provenance log — seed both so `forget` has
    // something real to remove, matching the invariant the two stores share.
    await new FileUserMemoryStore().upsertFact("journey-user", "home_city", "Seoul");

    const { AuthoredSkillStore } = await import("@muse/skills");
    const skillStore = new AuthoredSkillStore({ dir: process.env.MUSE_AUTHORED_SKILLS_DIR, now: () => new Date("2026-01-15T00:00:00.000Z") });
    await skillStore.writeOrPatch({ body: "Reconnect the office VPN when it drops.", description: "Reconnect the office VPN", name: "vpn-fix" });
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevPlaybook === undefined) delete process.env.MUSE_PLAYBOOK_FILE; else process.env.MUSE_PLAYBOOK_FILE = prevPlaybook;
    if (prevProvenance === undefined) delete process.env.MUSE_BELIEF_PROVENANCE_FILE; else process.env.MUSE_BELIEF_PROVENANCE_FILE = prevProvenance;
    if (prevSkillsDir === undefined) delete process.env.MUSE_AUTHORED_SKILLS_DIR; else process.env.MUSE_AUTHORED_SKILLS_DIR = prevSkillsDir;
    if (prevUserId === undefined) delete process.env.MUSE_USER_ID; else process.env.MUSE_USER_ID = prevUserId;
  });

  it("prints a merged, newest-first timeline across facts/skills/strategies", async () => {
    const { out } = await run([]);
    expect(out).toContain("home_city");
    expect(out).toContain("vpn-fix");
    expect(out).toContain("keep replies under 4 sentences");
    const factIdx = out.indexOf("Seoul");
    const strategyIdx = out.indexOf("keep replies under 4 sentences");
    expect(factIdx).toBeGreaterThan(-1);
    expect(strategyIdx).toBeGreaterThan(-1);
    // reinforced (2026-02-05) is newer than the fact supersession (2026-01-20)
    expect(out.indexOf("reinforced")).toBeLessThan(out.indexOf("superseded"));
    expect(out).toContain("no history recorded");
  });

  it("--json prints the raw event array", async () => {
    const { out } = await run(["--json"]);
    const parsed = JSON.parse(out) as readonly { readonly storeKind: string }[];
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed.some((e) => e.storeKind === "fact")).toBe(true);
    expect(parsed.some((e) => e.storeKind === "skill")).toBe(true);
    expect(parsed.some((e) => e.storeKind === "strategy")).toBe(true);
  });

  it("--kind filters to one store", async () => {
    const { out } = await run(["--kind", "skill", "--json"]);
    const parsed = JSON.parse(out) as readonly { readonly storeKind: string }[];
    expect(parsed.every((e) => e.storeKind === "skill")).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
  });

  it("rejects an invalid --kind", async () => {
    const { err, exitCode } = await run(["--kind", "nonsense"]);
    expect(err).toContain("--kind must be one of");
    expect(exitCode).toBe(1);
  });

  it("rejects an invalid --limit", async () => {
    const { err, exitCode } = await run(["--limit", "0"]);
    expect(err).toContain("--limit must be a positive integer");
    expect(exitCode).toBe(1);
  });

  it("forget <fact key> delegates to the memory-forget path and removes it", async () => {
    const { out } = await run(["forget", "home_city"]);
    expect(out).toContain("Forgot");
    const { FileUserMemoryStore } = await import("@muse/memory");
    const record = await new FileUserMemoryStore().findByUserId("journey-user");
    expect(record?.facts.home_city).toBeUndefined();
  });

  it("forget <strategy id prefix> delegates to removePlaybookStrategy", async () => {
    const { out } = await run(["forget", "pb_journeytest"]);
    expect(out).toContain("Removed strategy");
    const { queryPlaybook } = await import("@muse/stores");
    const remaining = await queryPlaybook(process.env.MUSE_PLAYBOOK_FILE as string, "journey-user");
    expect(remaining.find((e) => e.id === "pb_journeytest01")).toBeUndefined();
  });

  it("forget <skill name> refuses — no safe single-entry delete — and leaves the skill file untouched", async () => {
    const { out } = await run(["forget", "vpn-fix"]);
    expect(out).toContain("no safe single-entry delete");
    const { AuthoredSkillStore } = await import("@muse/skills");
    const skills = await new AuthoredSkillStore({ dir: process.env.MUSE_AUTHORED_SKILLS_DIR as string }).listAuthored();
    expect(skills.some((s) => s.name === "vpn-fix")).toBe(true);
  });

  it("forget <unknown ref> says nothing matches, mutates nothing", async () => {
    const { out } = await run(["forget", "totally-unknown-ref"]);
    expect(out).toContain("no journey entry matches");
    await expect(readFile(process.env.MUSE_PLAYBOOK_FILE as string, "utf8")).resolves.toContain("pb_journeytest01");
  });
});
