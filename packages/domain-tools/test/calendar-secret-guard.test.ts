import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CalendarProviderRegistry, LocalCalendarProvider } from "@muse/calendar";
import { createCalendarMcpServer } from "../src/index.js";

describe("muse.calendar add/update — fail-close secret-persistence guard", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "muse-calendar-secret-guard-"));
    file = join(dir, "calendar.json");
  });
  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  function server() {
    const registry = new CalendarProviderRegistry([new LocalCalendarProvider({ file })]);
    return createCalendarMcpServer({ registry });
  }
  const addTool = () => server().tools.find((t) => t.name === "add")!;
  const updateTool = () => server().tools.find((t) => t.name === "update")!;

  async function readEvents(): Promise<readonly { title: string }[]> {
    try {
      const raw = JSON.parse(await readFile(file, "utf8")) as { events?: readonly { title: string }[] };
      return raw.events ?? [];
    } catch {
      return [];
    }
  }

  it("add: refuses a password-bearing NOTES field and performs NO write", async () => {
    const out = await addTool().execute({ notes: "비밀번호는 hunter2", startsAt: "tomorrow 3pm", title: "라우터 재설정" }) as {
      error?: string;
      blocked?: boolean;
      kinds?: readonly string[];
    };
    expect(out.blocked).toBe(true);
    expect(out.error).toContain("암호화");
    expect(out.kinds).toContain("credential-label");
    expect(await readEvents()).toEqual([]);
  });

  it("add: refuses a password-bearing TITLE field and performs NO write", async () => {
    const out = await addTool().execute({ startsAt: "tomorrow 3pm", title: "비밀번호는 hunter2" }) as {
      blocked?: boolean;
    };
    expect(out.blocked).toBe(true);
    expect(await readEvents()).toEqual([]);
  });

  it("add: an ordinary event still writes normally (control — 팀 회의, 회의실 4)", async () => {
    const out = await addTool().execute({ location: "회의실 4", startsAt: "tomorrow 3pm", title: "팀 회의" }) as {
      event?: { title: string };
    };
    expect(out.event?.title).toBe("팀 회의");
    const events = await readEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.title).toBe("팀 회의");
  });

  it("update: refuses when the new notes carry a credential, event stays unchanged", async () => {
    const created = (await addTool().execute({ startsAt: "tomorrow 3pm", title: "팀 회의" }) as { event: { id: string } }).event;
    const before = await readEvents();
    const out = await updateTool().execute({ id: created.id, notes: "api key: sk-proj-abcdefghijklmnopqrstuvwxyz" }) as {
      blocked?: boolean;
    };
    expect(out.blocked).toBe(true);
    expect(await readEvents()).toEqual(before);
  });

  it("update: refuses when the new title carries a credential, event stays unchanged", async () => {
    const created = (await addTool().execute({ startsAt: "tomorrow 3pm", title: "팀 회의" }) as { event: { id: string } }).event;
    const before = await readEvents();
    const out = await updateTool().execute({ id: created.id, title: "비밀번호는 hunter2" }) as { blocked?: boolean };
    expect(out.blocked).toBe(true);
    expect(await readEvents()).toEqual(before);
  });

  it("update: an ordinary rename still works (no over-block regression)", async () => {
    const created = (await addTool().execute({ startsAt: "tomorrow 3pm", title: "팀 회의" }) as { event: { id: string } }).event;
    const out = await updateTool().execute({ id: created.id, title: "주간 팀 회의" }) as { event?: { title: string } };
    expect(out.event?.title).toBe("주간 팀 회의");
  });
});
