import { describe, expect, it } from "vitest";

import { createMuseRuntimeAssembly } from "../src/index.js";

describe("createMuseRuntimeAssembly — find_contact reachability", () => {
  it("exposes the read-only `find_contact` tool (no creds — local contacts store)", () => {
    const tool = createMuseRuntimeAssembly({ env: {} }).toolRegistry.get("find_contact");
    expect(tool).toBeDefined();
    expect(tool!.definition.risk).toBe("read");
  });

  it("exposes the `add_contact` write tool over the local store", () => {
    const tool = createMuseRuntimeAssembly({ env: {} }).toolRegistry.get("add_contact");
    expect(tool).toBeDefined();
    expect(tool!.definition.risk).toBe("write");
  });
});
