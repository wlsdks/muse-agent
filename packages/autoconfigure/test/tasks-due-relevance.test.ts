import { DefaultToolFilter } from "@muse/agent-core";
import { createLoopbackMcpMuseTools } from "@muse/mcp";
import { createTasksMcpServer } from "@muse/domain-tools";
import { describe, expect, it } from "vitest";

// The REAL tasks loopback tools, projected the production way, through
// the REAL relevance filter. The `list` tool answers "what's due
// today?" (832 dueWithinDays) — but the tasks DOMAIN keywords
// (task/todo/reminder) miss "due"/"overdue", so without per-tool
// keywords it was unreachable for due-queries.
const filter = new DefaultToolFilter();
const tools = createLoopbackMcpMuseTools(createTasksMcpServer({ file: "/tmp/muse-tasks-due-rel.json" }));

function surfaced(userMessage: string): string[] {
  return filter.filter(tools, { userMessage }).map((t) => t.definition.name);
}

describe("tasks list is selectable for due/overdue prompts", () => {
  it("'what's due today?' / 'anything overdue?' surface the tasks list tool", () => {
    expect(surfaced("what's due today?")).toContain("muse.tasks.list");
    expect(surfaced("anything overdue?")).toContain("muse.tasks.list");
    expect(surfaced("what's due this week?")).toContain("muse.tasks.list");
  });

  it("a plain task prompt still surfaces the task tools (domain heuristic intact)", () => {
    expect(surfaced("show my tasks")).toContain("muse.tasks.list");
  });

  it("a 'due' false-positive exposes ONLY the list tool, not add/complete", () => {
    const names = surfaced("the rent is due to the landlord");
    expect(names).not.toContain("muse.tasks.add");
    expect(names).not.toContain("muse.tasks.complete");
  });

  it("a clearly-unrelated prompt surfaces no task tools", () => {
    expect(surfaced("what is the capital of France?")).toEqual([]);
  });
});
