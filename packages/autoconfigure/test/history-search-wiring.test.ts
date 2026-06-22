import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createMuseRuntimeAssembly } from "../src/index.js";

// OUTCOME wiring test (Gap1-S2): the agent-callable `history_search` tool must
// actually be PRESENT in the assembled production tool registry and, when
// executed, return a labelled hit from the user's real episodes store — not
// just be exported. Goes through createMuseRuntimeAssembly (the real
// composition root), seeding episodes via MUSE_EPISODES_FILE.
const DIAGNOSTIC = { MUSE_MODEL: "diagnostic/smoke", MUSE_MODEL_PROVIDER_ID: "diagnostic" };

function seedEpisodes(userId: string): string {
  const dir = mkdtempSync(join(tmpdir(), "muse-hist-"));
  const file = join(dir, "episodes.json");
  const episodes = [
    {
      id: "ep-vpn",
      userId,
      startedAt: "2026-06-01T10:00:00.000Z",
      endedAt: "2026-06-01T10:30:00.000Z",
      summary: "We compared VPN MTU settings and fixed the dropped packets on the work laptop."
    },
    {
      id: "ep-ramen",
      userId,
      startedAt: "2026-06-02T12:00:00.000Z",
      endedAt: "2026-06-02T12:20:00.000Z",
      summary: "Chatted about the best ramen place downtown and weekend plans."
    }
  ];
  writeFileSync(file, JSON.stringify({ episodes }), "utf8");
  return file;
}

const ctx = { runId: "wiring-test", userId: "jinan" };
const findTool = (assembly: ReturnType<typeof createMuseRuntimeAssembly>) =>
  assembly.toolRegistry.list().find((t) => t.definition.name === "history_search");

describe("history_search runtime wiring (Gap1-S2)", () => {
  const savedUser = process.env.MUSE_USER_ID;
  afterEach(() => {
    delete process.env.MUSE_EPISODES_FILE;
    delete process.env.MUSE_HISTORY_SEARCH_ENABLED;
    if (savedUser === undefined) delete process.env.MUSE_USER_ID;
    else process.env.MUSE_USER_ID = savedUser;
  });

  it("registers history_search by default and it returns the matching past episode", async () => {
    process.env.MUSE_USER_ID = "jinan";
    process.env.MUSE_EPISODES_FILE = seedEpisodes("jinan");
    const assembly = createMuseRuntimeAssembly({ env: process.env });
    const tool = findTool(assembly);
    expect(tool).toBeTruthy();
    expect(tool!.definition.risk).toBe("read");

    const out = await tool!.execute({ query: "vpn mtu packets" }, ctx);
    const text = typeof out === "string" ? out : JSON.stringify(out);
    expect(text).toContain("ep-vpn");
    expect(text).toContain("VPN MTU");
    expect(text).not.toContain("ep-ramen");
  });

  it("is absent from the registry when MUSE_HISTORY_SEARCH_ENABLED=false", () => {
    process.env.MUSE_HISTORY_SEARCH_ENABLED = "false";
    const assembly = createMuseRuntimeAssembly({ env: { ...DIAGNOSTIC, MUSE_HISTORY_SEARCH_ENABLED: "false" } });
    expect(findTool(assembly)).toBeUndefined();
  });
});
