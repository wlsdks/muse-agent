import { describe, expect, it } from "vitest";

import type { BackgroundProcessRecord } from "@muse/stores";

import { createBackgroundListTool } from "../src/background-list-tool.js";

const rec = (over: Partial<BackgroundProcessRecord>): BackgroundProcessRecord => ({
  id: "p", pid: 4242, command: "npm run dev", startedAt: "2026-06-24T00:00:00.000Z", status: "running", ...over
});

describe("background_list tool (X-3)", () => {
  it("is a read-only system tool with an unambiguous name", () => {
    const tool = createBackgroundListTool({ processes: () => [] });
    expect(tool.definition.name).toBe("background_list");
    expect(tool.definition.risk).toBe("read");
  });

  it("lists processes (id/command/status, exitCode when present)", async () => {
    const tool = createBackgroundListTool({
      processes: () => [rec({ id: "a" }), rec({ id: "b", status: "exited", exitCode: 0 })]
    });
    const out = await tool.execute({}) as { count: number; processes: { id: string; status: string; exitCode?: number }[] };
    expect(out.count).toBe(2);
    expect(out.processes.map((p) => p.id)).toEqual(["a", "b"]);
    expect(out.processes[1]!.exitCode).toBe(0);
    expect(out.processes[0]!.exitCode).toBeUndefined();
  });

  it("filters by status", async () => {
    const tool = createBackgroundListTool({
      processes: () => [rec({ id: "a", status: "running" }), rec({ id: "b", status: "failed", exitCode: 1 })]
    });
    const out = await tool.execute({ status: "running" }) as { count: number; processes: { id: string }[] };
    expect(out.count).toBe(1);
    expect(out.processes[0]!.id).toBe("a");
  });
});
