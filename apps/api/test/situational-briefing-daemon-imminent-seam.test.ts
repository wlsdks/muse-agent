import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";

import { MessagingProviderRegistry, TelegramProvider } from "@muse/messaging";
import { addObjective, writeTasks } from "@muse/stores";
import { type BriefingImminent } from "@muse/proactivity";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startSituationalBriefingDaemonIfConfigured } from "../src/tick-daemons.js";
import type { ServerOptions } from "../src/server.js";

type TickOptions = { imminentProvider?: (now: Date) => Promise<readonly BriefingImminent[]> };

const hoisted = vi.hoisted(() => ({
  startSituationalBriefingTick: vi.fn((_options: TickOptions) => ({
    stop: () => {},
    tickOnce: async () => {}
  }))
}));

vi.mock("../src/situational-briefing-tick.js", () => ({
  startSituationalBriefingTick: hoisted.startSituationalBriefingTick
}));

function fakeServer(): { hooks: string[]; server: FastifyInstance } {
  const hooks: string[] = [];
  const server = {
    addHook: (name: string) => hooks.push(name),
    log: { info: () => {}, warn: () => {} }
  } as unknown as FastifyInstance;
  return { hooks, server };
}

function lastTickOptions(): TickOptions | undefined {
  return hoisted.startSituationalBriefingTick.mock.calls.at(-1)?.[0];
}

const ENV = { MUSE_BRIEFING_DESTINATION: "555", MUSE_BRIEFING_PROVIDER: "telegram" } as unknown as NodeJS.ProcessEnv;
const NOW = new Date("2026-05-19T12:00:00.000Z");

afterEach(() => {
  hoisted.startSituationalBriefingTick.mockClear();
});

describe("P8 audit (b3/b4) — the production briefing daemon builder grounds the briefing in real tasks + calendar", () => {
  it("startSituationalBriefingDaemonIfConfigured unions deriveBriefingImminent(tasksFile) + deriveCalendarBriefingImminent(calendar) from ServerOptions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-brief-seam-"));
    const objectivesFile = join(dir, "objectives.json");
    const tasksFile = join(dir, "tasks.json");

    await addObjective(objectivesFile, {
      createdAt: "2026-05-19T08:00:00.000Z",
      id: "obj_watch",
      kind: "until",
      spec: "watch the deploy until green",
      status: "active",
      userId: "stark"
    });
    await writeTasks(tasksFile, [
      {
        createdAt: "2026-05-19T08:00:00.000Z",
        dueAt: "2026-05-19T13:30:00.000Z",
        id: "t1",
        status: "open",
        title: "submit the Q3 report"
      }
    ]);

    const options = {
      briefingSidecarFile: join(dir, "brief-fired.json"),
      calendar: {
        listEvents: async () => [
          { allDay: false, startsAt: new Date("2026-05-19T12:20:00.000Z"), title: "Q3 review meeting" }
        ]
      },
      messaging: new MessagingProviderRegistry([
        new TelegramProvider({ baseUrl: "https://tg.test", fetch: async () => new Response("{}"), token: "T" })
      ]),
      objectivesFile,
      tasksFile
    } as unknown as ServerOptions;

    const { hooks, server } = fakeServer();
    startSituationalBriefingDaemonIfConfigured(ENV, server, options);

    // The production builder must have started the daemon and wired
    // an imminent source from BOTH ServerOptions.tasksFile and
    // ServerOptions.calendar — not the hand-built union the tick
    // tests use.
    expect(hooks).toContain("onClose");
    const imminentProvider = lastTickOptions()?.imminentProvider;
    expect(imminentProvider).toBeDefined();

    const imminent = await imminentProvider!(NOW);
    const task = imminent.find((i) => i.title === "submit the Q3 report");
    const event = imminent.find((i) => i.title === "Q3 review meeting");

    expect(task).toMatchObject({ kind: "task" });
    expect(event).toMatchObject({ kind: "calendar" });
    expect(event!.startsAt.toISOString()).toBe("2026-05-19T12:20:00.000Z");
    expect(imminent).toHaveLength(2);
  });

  it("with neither tasksFile nor calendar set, the builder wires NO imminent source (objective-status-only briefing)", () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-brief-seam-bare-"));
    const options = {
      briefingSidecarFile: join(dir, "brief-fired.json"),
      messaging: new MessagingProviderRegistry([
        new TelegramProvider({ baseUrl: "https://tg.test", fetch: async () => new Response("{}"), token: "T" })
      ]),
      objectivesFile: join(dir, "objectives.json")
    } as unknown as ServerOptions;

    const { server } = fakeServer();
    startSituationalBriefingDaemonIfConfigured(ENV, server, options);

    expect(lastTickOptions()?.imminentProvider).toBeUndefined();
  });
});
