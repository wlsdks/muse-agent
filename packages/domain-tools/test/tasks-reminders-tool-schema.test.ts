import { validateToolDefinitions, type MuseTool } from "@muse/tools";
import { describe, expect, it } from "vitest";

import { createFollowupsMcpServer, createRemindersMcpServer, createTasksMcpServer, createTasksRegistryMcpServer } from "../src/index.js";

function asMuseTools(tools: readonly { name: string; description: string; inputSchema?: unknown; risk?: unknown }[]): MuseTool[] {
  return tools.map((tool) => ({
    definition: {
      description: tool.description,
      inputSchema: (tool.inputSchema ?? { type: "object" }) as Record<string, unknown>,
      name: tool.name,
      risk: (tool.risk ?? "read") as "read" | "write" | "execute"
    },
    execute: async () => "unused"
  }));
}

const stubRegistry = { list: () => [], require: () => ({}), primary: () => undefined } as never;

describe("tasks + reminders loopback tools meet the one-shot tool-calling bar", () => {
  it("tasks tools describe ALL their parameters", () => {
    const server = createTasksMcpServer({ file: "/tmp/muse-test-tasks.json" });
    const issues = validateToolDefinitions(asMuseTools(server.tools));
    expect(issues.filter((i) => i.code === "undescribed_parameter")).toEqual([]);
    const add = server.tools.find((t) => t.name === "add")!;
    expect((add.inputSchema as { properties: Record<string, { description?: string }> }).properties.title.description ?? "").toContain("e.g.");
  });

  it("marks the tasks 'add' free-text notes + tags as groundedArgs (drop fabricated ones)", () => {
    const server = createTasksMcpServer({ file: "/tmp/muse-test-tasks.json" });
    const add = server.tools.find((t) => t.name === "add")!;
    expect((add as { groundedArgs?: readonly string[] }).groundedArgs).toEqual(["notes", "tags"]);
  });

  it("every lifecycle tool (complete/update/delete) carries action keywords so it isn't starved by add/list", () => {
    // "삭제해줘" was hitting tasks.add and "완료로 표시해줘" hit nothing, because only
    // add/list had keywords. Each lifecycle write needs its own verb + the task NOUN.
    const server = createTasksMcpServer({ file: "/tmp/muse-test-tasks.json" });
    const kwOf = (name: string) => ((server.tools.find((t) => t.name === name) as { keywords?: string[] })?.keywords ?? []);
    expect(kwOf("complete")).toEqual(expect.arrayContaining(["완료", "complete", "할 일"]));
    expect(kwOf("delete")).toEqual(expect.arrayContaining(["삭제", "delete", "할 일"]));
    expect(kwOf("update")).toEqual(expect.arrayContaining(["변경", "update", "할 일"]));
  });

  it("the title/text `id` ref tells the model NOT to translate it (a Korean '운동하기'/'약 먹기' got matched only ~2/3 when translated)", () => {
    const idDesc = (server: { tools: readonly { name: string; inputSchema?: unknown }[] }, name: string): string =>
      ((server.tools.find((t) => t.name === name)?.inputSchema as { properties?: Record<string, { description?: string }> })?.properties?.id?.description ?? "");
    const tasks = createTasksMcpServer({ file: "/tmp/muse-test-tasks.json" });
    for (const name of ["complete", "update", "delete"]) {
      expect(idDesc(tasks, name).toLowerCase()).toContain("translate");
      expect(idDesc(tasks, name)).toMatch(/운동|보고서/u);
    }
    const reminders = createRemindersMcpServer({ file: "/tmp/muse-test-reminders.json" });
    for (const name of ["snooze", "clear"]) {
      expect(idDesc(reminders, name).toLowerCase()).toContain("translate");
      expect(idDesc(reminders, name)).toMatch(/약|운동/u);
    }
  });

  it("tasks-registry tools describe ALL their parameters", () => {
    const server = createTasksRegistryMcpServer({ registry: stubRegistry });
    expect(validateToolDefinitions(asMuseTools(server.tools)).filter((i) => i.code === "undescribed_parameter")).toEqual([]);
  });

  it("reminders tools describe ALL their parameters", () => {
    const server = createRemindersMcpServer({ file: "/tmp/muse-test-reminders.json" });
    expect(validateToolDefinitions(asMuseTools(server.tools)).filter((i) => i.code === "undescribed_parameter")).toEqual([]);
  });

  it("exposes the reminders list tool as a verb_noun 'list' (NOT 'due') with reminder keywords", () => {
    // The local model picked `calendar.list` for "내 리마인더 보여줘" because the
    // reminders list tool was misnamed `due` with no keywords — and wrongly said
    // "you have no reminders". The tool is `list`, keyworded so the relevance
    // filter surfaces it for reminder-list prompts.
    const server = createRemindersMcpServer({ file: "/tmp/muse-test-reminders.json" });
    const names = server.tools.map((t) => t.name);
    expect(names).toContain("list");
    expect(names).not.toContain("due");
    const list = server.tools.find((t) => t.name === "list")!;
    const kw = (list as { keywords?: string[] }).keywords ?? [];
    for (const w of ["리마인더", "보여줘", "reminders"]) expect(kw).toContain(w);
  });

  it("reminders.add carries reminder keywords and tasks.add does NOT pull reminder intent", () => {
    // "내일 9시 회의 리마인더 추가해줘" was adding a TASK because reminders.add had
    // no keywords (score 0) while tasks.add matched "추가" (score 1). reminders.add
    // must own 리마인더/알림/remind so it outranks tasks.add for reminder intent;
    // tasks.add must NOT keep "remind me to" (which dragged reminder intent to tasks).
    const remAdd = createRemindersMcpServer({ file: "/tmp/muse-test-reminders.json" }).tools.find((t) => t.name === "add")!;
    const remKw = (remAdd as { keywords?: string[] }).keywords ?? [];
    for (const w of ["리마인더", "알림", "remind"]) expect(remKw).toContain(w);

    const taskAdd = createTasksMcpServer({ file: "/tmp/muse-test-tasks.json" }).tools.find((t) => t.name === "add")!;
    const taskKw = (taskAdd as { keywords?: string[] }).keywords ?? [];
    expect(taskKw).not.toContain("remind me to");
    expect(taskKw).not.toContain("리마인더");
  });

  it("reminders snooze/clear own the reminder NOUN + verb so '리마인더 미뤄/삭제' isn't hijacked by tasks", () => {
    // "약 먹기 리마인더 30분 미뤄줘" got no tool and "…지워줘" hit tasks.delete because
    // snooze/clear had no keywords. Each reminder lifecycle write needs the noun + verb.
    const server = createRemindersMcpServer({ file: "/tmp/muse-test-reminders.json" });
    const kwOf = (name: string) => ((server.tools.find((t) => t.name === name) as { keywords?: string[] })?.keywords ?? []);
    for (const w of ["리마인더", "미뤄", "snooze"]) expect(kwOf("snooze")).toContain(w);
    for (const w of ["리마인더", "삭제", "clear"]) expect(kwOf("clear")).toContain(w);
  });

  it("marks the tasks 'update' optional notes as groundedArgs (drop fabricated notes on update)", () => {
    const server = createTasksMcpServer({ file: "/tmp/muse-test-tasks.json" });
    const update = server.tools.find((t) => t.name === "update")!;
    expect((update as { groundedArgs?: readonly string[] }).groundedArgs).toContain("notes");
  });

  it("marks the followup 'cancel' optional reason as groundedArgs (drop fabricated cancel reasons)", () => {
    const server = createFollowupsMcpServer({ file: "/tmp/muse-test-followups.json" });
    const cancel = server.tools.find((t) => t.name === "cancel")!;
    expect((cancel as { groundedArgs?: readonly string[] }).groundedArgs).toContain("reason");
  });
});
