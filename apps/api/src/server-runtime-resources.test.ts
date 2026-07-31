import { describe, expect, it, vi } from "vitest";

import { buildServer } from "./server.js";

describe("server runtime resource lifecycle", () => {
  it("closes assembly-owned resources from Fastify onClose", async () => {
    const closeRuntimeResources = vi.fn(async () => undefined);
    const server = buildServer({
      closeRuntimeResources,
      env: {}
    });

    await server.ready();
    await server.close();

    expect(closeRuntimeResources).toHaveBeenCalledOnce();
  });
});
