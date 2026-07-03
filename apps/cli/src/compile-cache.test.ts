import { afterEach, describe, expect, it, vi } from "vitest";

describe("enableCliCompileCache", () => {
  afterEach(() => {
    vi.doUnmock("node:module");
    vi.resetModules();
  });

  it("calls node:module's enableCompileCache with no pinned directory", async () => {
    const enableCompileCache = vi.fn();
    vi.doMock("node:module", () => ({ enableCompileCache }));
    vi.resetModules();

    const { enableCliCompileCache } = await import("./compile-cache.js");
    enableCliCompileCache();

    expect(enableCompileCache).toHaveBeenCalledWith();
  });

  it("is best-effort — a throwing enableCompileCache never propagates", async () => {
    vi.doMock("node:module", () => ({
      enableCompileCache: () => {
        throw new Error("EACCES: read-only cache directory");
      },
    }));
    vi.resetModules();

    const { enableCliCompileCache } = await import("./compile-cache.js");
    expect(() => enableCliCompileCache()).not.toThrow();
  });

  it("importing the module for real does not throw on this runtime", async () => {
    await expect(import("./compile-cache.js")).resolves.toBeDefined();
  });
});
