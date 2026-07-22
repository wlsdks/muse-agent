import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ObserveCollector } from "./observe-collector.js";
import { createPersonalThread } from "./attunement-store.js";
import { startObserveSession } from "./observe-store.js";
import {
  createObserveActiveAppSource,
  createObserveRunner,
  createObserveRunnerFromEnvironment,
  readObserveAppMapping
} from "./observe-runtime.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

async function mapping(contents = '{"version":1,"apps":{"com.example.Editor":"writing"}}'): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "muse-observe-map-"));
  directories.push(directory);
  const file = join(directory, "apps.json");
  await writeFile(file, contents);
  await chmod(file, 0o600);
  return file;
}

describe("Observe app-only runtime", () => {
  it("reads an exact owner-only map without fallback matching", async () => {
    const parsed = await readObserveAppMapping(await mapping());
    expect(parsed.apps["com.example.Editor"]).toBe("writing");
    expect(parsed.apps["COM.EXAMPLE.EDITOR"]).toBeUndefined();
    await expect(readObserveAppMapping(await mapping('{"version":1,"apps":{"x":"writing","x":"research"}}'))).rejects.toThrow("invalid JSON");
    const target = await mapping();
    const alias = `${target}.alias`;
    await symlink(target, alias);
    await expect(readObserveAppMapping(alias)).rejects.toThrow("non-symlink");
    if (process.platform !== "win32") {
      await chmod(target, 0o644);
      await expect(readObserveAppMapping(target)).rejects.toThrow("owner-only");
    }
  });

  it("uses fixed app-only commands and never discloses invalid raw ids", async () => {
    const execute = vi.fn(async () => ({ exitCode: 0, stderr: new Uint8Array(), stdout: Buffer.from("com.example.Editor\n") }));
    await expect(createObserveActiveAppSource("macos", execute).read()).resolves.toBe("com.example.Editor");
    expect(execute).toHaveBeenCalledWith("/usr/bin/osascript", ["-e", expect.stringContaining("bundle identifier")]);

    const raw = " secret-app ";
    const invalid = createObserveActiveAppSource("windows", async () => ({ exitCode: 0, stderr: new Uint8Array(), stdout: Buffer.from(`${raw}\n`) }));
    await expect(invalid.read()).rejects.not.toThrow(raw);
    for (const output of ["missing-newline", "two\nlines\n", " padded \n", "nul\0byte\n", "\n"]) {
      const source = createObserveActiveAppSource("macos", async () => ({ exitCode: 0, stderr: new Uint8Array(), stdout: Buffer.from(output) }));
      await expect(source.read()).rejects.toThrow("invalid identifier");
    }
  });

  it("claims before source and samples at most once per tick", async () => {
    const events: string[] = [];
    const collector: ObserveCollector = {
      claim: async () => { events.push("claim"); },
      release: async () => { events.push("release"); },
      renew: async () => { events.push("renew"); },
      sample: async (category) => { events.push(`sample:${category}`); }
    };
    const runner = createObserveRunner({
      collector,
      mapping: { apps: { editor: "writing" }, version: 1 },
      source: { read: async () => { events.push("source"); return "editor"; } }
    });
    await expect(runner.tick()).resolves.toBe("sampled");
    expect(events).toEqual(["claim", "source", "sample:writing"]);
    await runner.shutdown();
    await expect(runner.tick()).resolves.toBe("ignored");
  });

  it("does not sample an unmapped app identifier", async () => {
    const collector: ObserveCollector = {
      claim: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
      renew: vi.fn(async () => undefined),
      sample: vi.fn(async () => undefined)
    };
    const runner = createObserveRunner({ collector, mapping: { apps: {}, version: 1 }, source: { read: async () => "unknown" } });
    await expect(runner.tick()).resolves.toBe("ignored");
    expect(collector.claim).toHaveBeenCalledOnce();
    expect(collector.sample).not.toHaveBeenCalled();
  });

  it("captures one clock value and joins an in-flight tick before shutdown release", async () => {
    let resolveClaim!: () => void;
    const claimGate = new Promise<void>((resolve) => { resolveClaim = resolve; });
    const events: string[] = [];
    const times: string[] = [];
    const collector: ObserveCollector = {
      claim: async (at) => { times.push(at!); events.push("claim-start"); await claimGate; events.push("claim-end"); },
      release: async () => { events.push("release"); },
      renew: async () => undefined,
      sample: async (_category, at) => { times.push(at!); events.push("sample"); }
    };
    let clockCalls = 0;
    const runner = createObserveRunner({
      collector,
      mapping: { apps: { editor: "writing" }, version: 1 },
      now: () => { clockCalls += 1; return new Date("2026-07-22T00:00:01.000Z"); },
      source: { read: async () => "editor" }
    });
    const tick = runner.tick();
    const shutdown = runner.shutdown();
    expect(events).toEqual(["claim-start"]);
    resolveClaim();
    await expect(tick).resolves.toBe("sampled");
    await shutdown;
    expect(events).toEqual(["claim-start", "claim-end", "sample", "release"]);
    expect(times).toEqual(["2026-07-22T00:00:01.000Z", "2026-07-22T00:00:01.000Z"]);
    expect(clockCalls).toBe(1);
  });

  it("lets only one of two configured daemons execute the source across pass^5", async () => {
    for (let pass = 0; pass < 5; pass += 1) {
      const directory = await mkdtemp(join(tmpdir(), "muse-observe-dual-"));
      directories.push(directory);
      const mapFile = join(directory, "apps.json");
      await writeFile(mapFile, '{"version":1,"apps":{"editor":"writing"}}');
      await chmod(mapFile, 0o600);
      const attunementFile = join(directory, "attunement.json");
      await createPersonalThread(attunementFile, { kind: "work", title: "Thread" }, { idFactory: () => "a" });
      const attunementAlias = join(directory, "attunement-alias.json");
      await symlink(attunementFile, attunementAlias);
      await startObserveSession(`${attunementFile}.observe.json`, { acceptVersion: 1, threadId: "thread_a" }, {
        idFactory: () => "observe_00000000-0000-4000-8000-000000000001",
        now: () => new Date("2026-07-22T00:00:00.000Z")
      });
      let sourceCalls = 0;
      const env = {
        MUSE_OBSERVE_ENABLED: "true",
        MUSE_OBSERVE_INTERVAL_MS: "10000",
        MUSE_OBSERVE_MAP_FILE: mapFile,
        MUSE_OBSERVE_PLATFORM: "macos",
        MUSE_OBSERVE_SESSION_ID: "observe_00000000-0000-4000-8000-000000000001",
        MUSE_OBSERVE_THREAD_ID: "thread_a"
      };
      const options = {
        assertKnownThread: async () => undefined,
        attunementFile,
        env,
        execute: async () => { sourceCalls += 1; return { exitCode: 0, stderr: new Uint8Array(), stdout: Buffer.from("editor\n") }; },
        now: () => new Date("2026-07-22T00:00:01.000Z"),
        platform: "darwin" as const
      };
      const first = await createObserveRunnerFromEnvironment(options);
      const second = await createObserveRunnerFromEnvironment({ ...options, attunementFile: attunementAlias });
      await expect(first!.tick()).resolves.toBe("sampled");
      await expect(second!.tick()).rejects.toMatchObject({ code: "conflict" });
      expect(sourceCalls).toBe(1);
      await first!.shutdown();
      await second!.shutdown();
    }
  });

  it("rejects a session/thread config mismatch before any source command", async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-observe-mismatch-"));
    directories.push(directory);
    const mapFile = join(directory, "apps.json");
    await writeFile(mapFile, '{"version":1,"apps":{"editor":"writing"}}');
    await chmod(mapFile, 0o600);
    const attunementFile = join(directory, "attunement.json");
    await createPersonalThread(attunementFile, { kind: "work", title: "A" }, { idFactory: () => "a" });
    await createPersonalThread(attunementFile, { kind: "work", title: "B" }, { idFactory: () => "b" });
    await startObserveSession(`${attunementFile}.observe.json`, { acceptVersion: 1, threadId: "thread_a" }, {
      idFactory: () => "observe_00000000-0000-4000-8000-000000000001",
      now: () => new Date("2026-07-22T00:00:00.000Z")
    });
    let sourceCalls = 0;
    await expect(createObserveRunnerFromEnvironment({
      assertKnownThread: async () => undefined,
      attunementFile,
      env: {
        MUSE_OBSERVE_ENABLED: "true",
        MUSE_OBSERVE_INTERVAL_MS: "10000",
        MUSE_OBSERVE_MAP_FILE: mapFile,
        MUSE_OBSERVE_PLATFORM: "macos",
        MUSE_OBSERVE_SESSION_ID: "observe_00000000-0000-4000-8000-000000000001",
        MUSE_OBSERVE_THREAD_ID: "thread_b"
      },
      execute: async () => { sourceCalls += 1; return { exitCode: 0, stderr: new Uint8Array(), stdout: Buffer.from("editor\n") }; },
      platform: "darwin"
    })).rejects.toMatchObject({ code: "conflict" });
    expect(sourceCalls).toBe(0);
  });

  it("keeps Observe collection independent from model, messaging, browser, ambient, and clipboard paths", async () => {
    const sources = await Promise.all(["observe-runtime.ts", "observe-collector.ts", "observe-continuity-coordinator.ts"].map((name) => readFile(new URL(name, import.meta.url), "utf8")));
    const combined = sources.join("\n");
    expect(combined).not.toMatch(/from\s+["']@muse\/(?:model|messaging|proactivity|agent-core)["']/u);
    expect(combined).not.toMatch(/MUSE_(?:AMBIENT|CLIPBOARD)/u);
    expect(combined).not.toMatch(/evaluateTiming|recordTiming|openContinuity|sendMessage|browser/u);
  });
});
