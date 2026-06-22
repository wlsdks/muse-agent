import { describe, expect, it } from "vitest";

import { describeBuiltinLoopbackMcpServers } from "@muse/domain-tools";

const catalog = describeBuiltinLoopbackMcpServers();
const byName = new Map(catalog.map((entry) => [entry.name, entry]));

describe("describeBuiltinLoopbackMcpServers", () => {
  it("gives every entry a name, string description, and tools carrying a name + risk", () => {
    expect(catalog.length).toBeGreaterThan(0);
    for (const entry of catalog) {
      expect(typeof entry.name).toBe("string");
      expect(entry.name.length).toBeGreaterThan(0);
      expect(typeof entry.description).toBe("string");
      expect(typeof entry.optIn).toBe("boolean");
      expect(entry.tools.length).toBeGreaterThan(0);
      for (const tool of entry.tools) {
        expect(tool.name.length).toBeGreaterThan(0);
        expect(tool).toHaveProperty("risk");
      }
    }
  });

  it("lists the always-on default servers as opt-in=false with no requires", () => {
    for (const name of ["muse.time", "muse.text", "muse.math", "muse.json", "muse.url", "muse.crypto", "muse.diff", "muse.regex", "muse.search", "muse.reminders"]) {
      const entry = byName.get(name);
      expect(entry, `${name} should be catalogued`).toBeDefined();
      expect(entry!.optIn).toBe(false);
      expect(entry!.requires).toBeUndefined();
    }
  });

  it("marks the config-gated servers opt-in=true with the credential/option they require", () => {
    expect(byName.get("muse.fetch")).toMatchObject({ optIn: true, requires: ["allowedHosts (FetchMcpServerOptions.allowedHosts)"] });
    expect(byName.get("muse.fs")).toMatchObject({ optIn: true, requires: ["allowedRoots (FilesystemMcpServerOptions.allowedRoots)"] });
    const messaging = byName.get("muse.messaging");
    expect(messaging?.optIn).toBe(true);
    expect(messaging?.requires?.[0]).toContain("MUSE_TELEGRAM_BOT_TOKEN");
  });

  it("advertises the full messaging surface from the catalog even though it is not wired by default", () => {
    const messaging = byName.get("muse.messaging");
    const toolNames = messaging!.tools.map((t) => t.name);
    expect(toolNames).toContain("poll_now"); // surfaced via the stub so the LLM sees the whole surface
  });
});
