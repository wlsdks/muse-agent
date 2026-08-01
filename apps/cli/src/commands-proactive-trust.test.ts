import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readTrustLedger, type TrustLedgerEntry } from "@muse/stores";

import {
  registerProactiveTrustSubcommands,
  renderTrustScoreboard
} from "./commands-proactive-trust.js";
import type { ProgramIO } from "./program.js";

const entry = (over: Partial<TrustLedgerEntry>): TrustLedgerEntry => ({
  kind: "task",
  sourceKey: "task:t-1",
  surfacedAtMs: Date.parse("2026-05-18T09:00:00Z"),
  title: "Q3 memo",
  ...over
});

describe("renderTrustScoreboard", () => {
  it("shows the no-signal state when nothing has surfaced", () => {
    const out = renderTrustScoreboard([]);
    expect(out).toContain("No proactive notices yet");
    expect(out).not.toContain("Precision:");
    expect(out).toContain("muse proactive keep latest");
  });

  it("renders precision + recent surfaces, most recent first", () => {
    const out = renderTrustScoreboard([
      entry({ outcome: "kept", sourceKey: "task:t-1", surfacedAtMs: 1_000, title: "First" }),
      entry({ outcome: "vetoed", sourceKey: "calendar:e-2", surfacedAtMs: 3_000, title: "Second" }),
      entry({ sourceKey: "task:t-3", surfacedAtMs: 2_000, title: "Third" })
    ]);
    expect(out).toContain("Surfaced: 3");
    expect(out).toContain("Vetoed: 1");
    // precision = (3 - 1) / 3 = 67%
    expect(out).toContain("Precision: 67%");
    // most-recent-first ordering: calendar:e-2 (3000) before task:t-3 (2000) before task:t-1 (1000)
    const order = ["calendar:e-2", "task:t-3", "task:t-1"].map((k) => out.indexOf(k));
    expect(order[0]).toBeLessThan(order[1]!);
    expect(order[1]).toBeLessThan(order[2]!);
    expect(out).toContain("✗ vetoed");
    expect(out).toContain("muse proactive veto <source>");
    expect(out).toContain("muse proactive acted|keep|veto latest");
  });
});

describe("proactive outcome commands", () => {
  let dir: string;
  let file: string;
  let previousTrustFile: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "muse-proactive-latest-"));
    file = join(dir, "proactive-trust.json");
    previousTrustFile = process.env.MUSE_PROACTIVE_TRUST_FILE;
    process.env.MUSE_PROACTIVE_TRUST_FILE = file;
  });

  afterEach(async () => {
    if (previousTrustFile === undefined) delete process.env.MUSE_PROACTIVE_TRUST_FILE;
    else process.env.MUSE_PROACTIVE_TRUST_FILE = previousTrustFile;
    await rm(dir, { force: true, recursive: true });
  });

  const writeLedger = async (entries: readonly TrustLedgerEntry[]): Promise<void> => {
    await writeFile(file, `${JSON.stringify({ surfaced: entries }, null, 2)}\n`, "utf8");
  };

  const run = async (args: readonly string[]): Promise<{
    readonly exitCode: number | undefined;
    readonly stderr: string;
    readonly stdout: string;
  }> => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io: ProgramIO = { stderr: (message) => stderr.push(message), stdout: (message) => stdout.push(message) };
    const program = new Command();
    program.exitOverride();
    registerProactiveTrustSubcommands(program.command("proactive"), io);
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await program.parseAsync(["node", "muse", "proactive", ...args]);
      return { exitCode: process.exitCode, stderr: stderr.join(""), stdout: stdout.join("") };
    } finally {
      process.exitCode = previousExitCode;
    }
  };

  it.each([
    ["acted", "acted"],
    ["keep", "kept"],
    ["veto", "vetoed"]
  ] as const)("%s latest rates the latest eligible surface", async (verb, outcome) => {
    await writeLedger([
      entry({ sourceKey: "task:earlier", surfacedAtMs: 1_000, title: "Earlier" }),
      entry({ sourceKey: "task:latest", surfacedAtMs: 2_000, title: "Latest" })
    ]);

    const result = await run([verb, "latest"]);

    expect(result).toMatchObject({ exitCode: undefined, stderr: "" });
    expect(result.stdout).toContain("task:latest");
    const entries = await readTrustLedger(file);
    expect(entries[0]!.outcome).toBeUndefined();
    expect(entries[1]).toMatchObject({ outcome, sourceKey: "task:latest" });
  });

  it("latest uses the eligible tie winner instead of newer synthetic or rated rows", async () => {
    await writeLedger([
      entry({ sourceKey: "task:tied-first", surfacedAtMs: 5_000 }),
      entry({ outcome: "acted", sourceKey: "task:rated", surfacedAtMs: 9_000 }),
      entry({ recordedWithoutSurface: true, sourceKey: "task:synthetic", surfacedAtMs: 10_000 }),
      entry({ sourceKey: "task:tied-later", surfacedAtMs: 5_000 })
    ]);

    await run(["keep", "latest"]);

    const entries = await readTrustLedger(file);
    expect(entries[0]!.outcome).toBeUndefined();
    expect(entries[1]!.outcome).toBe("acted");
    expect(entries[2]!.outcome).toBeUndefined();
    expect(entries[3]!.outcome).toBe("kept");
  });

  it("fails without rewriting the ledger when no eligible surface exists", async () => {
    const raw = JSON.stringify({ surfaced: [
      entry({ outcome: "acted", sourceKey: "task:rated" }),
      entry({ outcome: "vetoed", recordedWithoutSurface: true, sourceKey: "task:synthetic" })
    ] });
    await writeFile(file, raw, "utf8");

    const result = await run(["acted", "latest"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No unrated proactive surface is available");
    expect(await readFile(file, "utf8")).toBe(raw);
  });

  it("keeps explicit-source pre-emption and latest-outcome-wins reversal unchanged", async () => {
    await writeLedger([]);

    expect((await run(["veto", "task:explicit"])).stdout).toContain("no prior surface on record");
    expect((await run(["keep", "task:explicit"])).stdout).toContain("no prior surface on record");

    const entries = await readTrustLedger(file);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      outcome: "vetoed",
      recordedWithoutSurface: true,
      sourceKey: "task:explicit"
    });
    expect(entries[1]).toMatchObject({
      outcome: "kept",
      recordedWithoutSurface: true,
      sourceKey: "task:explicit"
    });
  });

  it("advertises latest in command help", () => {
    const program = new Command();
    registerProactiveTrustSubcommands(program, { stderr: () => undefined, stdout: () => undefined });
    for (const command of program.commands.filter((candidate) => candidate.name() !== "scoreboard")) {
      expect(command.helpInformation()).toContain("<source|latest>");
      expect(command.description()).toContain("use 'latest'");
    }
  });
});
