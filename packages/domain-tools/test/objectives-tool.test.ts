import { describe, expect, it } from "vitest";

import { createObjectivesListTool } from "../src/index.js";
import { type StandingObjective } from "@muse/mcp";

const OBJ: StandingObjective[] = [
  { createdAt: "2026-06-01T00:00:00Z", id: "o1", kind: "until", spec: "watch the CI until it's green", status: "active", userId: "u" },
  { createdAt: "2026-06-02T00:00:00Z", id: "o2", kind: "notify", spec: "tell me when the package ships", status: "escalated", userId: "u" },
  { createdAt: "2026-05-01T00:00:00Z", id: "o3", kind: "watch", resolution: "shipped", spec: "watch the old build", status: "done", userId: "u" },
  { createdAt: "2026-05-02T00:00:00Z", id: "o4", kind: "watch", spec: "cancelled goal", status: "cancelled", userId: "u" }
];

function tool(objectives: StandingObjective[] = OBJ) {
  return createObjectivesListTool({ objectives: () => objectives });
}

describe("createObjectivesListTool — what Muse is pursuing for you", () => {
  it("is risk:read and lists only LIVE (active/escalated) objectives with spec/kind/status (value flows)", async () => {
    const t = tool();
    expect(t.definition.risk).toBe("read");
    const out = await t.execute({}) as { count: number; objectives: { spec: string; kind: string; status: string }[] };
    expect(out.count).toBe(2);
    expect(out.objectives.map((o) => o.spec).sort()).toEqual(["tell me when the package ships", "watch the CI until it's green"]);
    expect(out.objectives.map((o) => o.status).sort()).toEqual(["active", "escalated"]);
    expect(out.objectives.find((o) => o.spec.startsWith("watch the CI"))).toMatchObject({ kind: "until", status: "active" });
    // done / cancelled are not "what I'm working toward" — excluded.
    expect(out.objectives.some((o) => o.spec.includes("old build"))).toBe(false);
    expect(out.objectives.some((o) => o.spec === "cancelled goal")).toBe(false);
  });

  it("returns an empty list when nothing is live", async () => {
    const out = await tool([{ createdAt: "2026-05-01T00:00:00Z", id: "x", kind: "watch", spec: "done goal", status: "done", userId: "u" }]).execute({}) as { count: number; objectives: unknown[] };
    expect(out.count).toBe(0);
    expect(out.objectives).toEqual([]);
  });
});
