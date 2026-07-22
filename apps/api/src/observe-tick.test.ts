import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { startObserveDaemonIfConfigured } from "./observe-tick.js";

interface TestRunner { shutdown(): Promise<void>; tick(): Promise<"busy" | "ignored" | "sampled"> }

describe("API Observe daemon composition", () => {
  it("does not start a timer after server close wins an async factory race", async () => {
    let resolveFactory!: (runner: TestRunner) => void;
    const factory = vi.fn(() => new Promise<TestRunner | undefined>((resolve) => { resolveFactory = (runner) => resolve(runner); }));
    const runner: TestRunner = { shutdown: vi.fn(async () => undefined), tick: vi.fn(async (): Promise<"sampled"> => "sampled") };
    const app = Fastify();
    startObserveDaemonIfConfigured({ MUSE_OBSERVE_INTERVAL_MS: "10000" }, app, "/tmp/attunement.json", { createRunner: factory });
    await app.close();
    resolveFactory(runner);
    await vi.waitFor(() => expect(runner.shutdown).toHaveBeenCalledOnce());
    expect(runner.tick).not.toHaveBeenCalled();
  });

  it("starts one fail-soft tick and releases it on close", async () => {
    const runner: TestRunner = { shutdown: vi.fn(async () => undefined), tick: vi.fn(async (): Promise<"sampled"> => "sampled") };
    const app = Fastify();
    startObserveDaemonIfConfigured({ MUSE_OBSERVE_INTERVAL_MS: "10000" }, app, "/tmp/attunement.json", { createRunner: async () => runner });
    await vi.waitFor(() => expect(runner.tick).toHaveBeenCalledOnce());
    await app.close();
    expect(runner.shutdown).toHaveBeenCalledOnce();
  });
});
