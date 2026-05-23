import { describe, expect, it } from "vitest";

import { createMuseRuntimeAssembly } from "../src/index.js";

describe("createMuseRuntimeAssembly — email_recent read tool reachability gating", () => {
  it("exposes email_recent (risk:read) when MUSE_GMAIL_TOKEN is set", () => {
    const assembly = createMuseRuntimeAssembly({ env: { MUSE_GMAIL_TOKEN: "tok" } });
    const tool = assembly.toolRegistry.get("email_recent");
    expect(tool).toBeDefined();
    expect(tool!.definition.risk).toBe("read");
  });

  it("does NOT expose email_recent without the Gmail token (opt-in)", () => {
    expect(createMuseRuntimeAssembly({ env: {} }).toolRegistry.get("email_recent")).toBeUndefined();
  });
});
