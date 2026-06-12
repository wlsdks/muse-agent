import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CalendarProviderRegistry } from "@muse/calendar";
import { MessagingProviderRegistry } from "@muse/messaging";
import { describe, expect, it } from "vitest";

import { buildLoopbackTools, type LoopbackToolsBundle, type LoopbackToolsDeps } from "../src/loopback-tools.js";

// Coverage for buildLoopbackTools (untested) — the assembly seam that decides
// WHICH in-process tools the local model actually sees. tool-calling.md's first
// concern is keeping the exposed set tight and free of always-erroring tools,
// so the GATING contract here is load-bearing: a group must be omitted when its
// dependency is absent (no calendar provider → no calendar tools; no messaging
// provider or poll fns → no messaging tools that would only error). Exercises
// the real assembly with real registries + tmp file paths.

const dir = mkdtempSync(join(tmpdir(), "muse-loopback-"));
const path = (name: string): string => join(dir, name);

const baseDeps = (over: Partial<LoopbackToolsDeps> = {}): LoopbackToolsDeps => ({
  actionLogFile: path("action-log.json"),
  calendarRegistry: new CalendarProviderRegistry([]),
  env: {} as LoopbackToolsDeps["env"],
  episodesFile: path("episodes.json"),
  followupsFile: path("followups.json"),
  messagingRegistry: new MessagingProviderRegistry([]),
  notesDir: path("notes"),
  notesRegistry: undefined,
  patternsFiredFile: path("patterns.json"),
  pollAll: undefined,
  pollNow: undefined,
  proactiveHistoryFile: path("proactive.json"),
  reminderHistoryFile: path("reminder-history.json"),
  remindersFile: path("reminders.json"),
  tasksFile: path("tasks.json"),
  tasksRegistry: undefined,
  userId: "u1",
  ...over
});

const populated = (bundle: LoopbackToolsBundle): string[] =>
  Object.entries(bundle).filter(([, tools]) => tools.length > 0).map(([key]) => key).sort();

const calProvider = () => ({
  createEvent: async () => ({}), deleteEvent: async () => {}, describe: () => ({ credentials: [], description: "", displayName: "l", id: "local", local: true }),
  id: "local", listEvents: async () => [], updateEvent: async () => ({})
}) as unknown as Parameters<CalendarProviderRegistry["register"]>[0];

const msgProvider = () => ({ describe: () => ({ configured: true, displayName: "t", id: "tg" }), id: "tg", send: async () => {} }) as never;

// A duck registry: the multi-provider gate only consults `.list().length`.
const duckRegistry = (count: number) => ({ list: () => Array.from({ length: count }, (_unused, i) => ({ id: `p${i.toString()}` })) }) as never;

describe("buildLoopbackTools — gating", () => {
  it("with minimal deps exposes the always-on groups and notes/tasks (default-on), but omits the dependency-gated ones", () => {
    const bundle = buildLoopbackTools(baseDeps());
    expect(populated(bundle)).toEqual(["episodes", "followups", "history", "math", "notes", "patterns", "proactive", "reminders", "search", "status", "tasks", "webRead"]);
    // gated groups absent without their dependency:
    expect(bundle.calendar).toEqual([]);
    expect(bundle.messaging).toEqual([]);
    expect(bundle.notesRegistry).toEqual([]);
    expect(bundle.tasksRegistry).toEqual([]);
  });

  it("wires the deterministic math evaluator (muse.math.evaluate) into the default tool set — the 8B can't be trusted with digits", () => {
    const bundle = buildLoopbackTools(baseDeps());
    expect(bundle.math.some((t) => t.definition.name.endsWith("evaluate"))).toBe(true);
    expect(bundle.math.every((t) => t.definition.risk === "read")).toBe(true);
  });

  it("wires web search (muse.search) into the default tool set — a JARVIS-class assistant must answer fresh-web questions", () => {
    const bundle = buildLoopbackTools(baseDeps());
    expect(bundle.search.map((t) => t.definition.name)).toContain("muse.search.search");
    expect(bundle.search[0]?.definition.risk).toBe("read");
  });

  it("respects MUSE_SEARCH_ENABLED=false (web search is opt-out)", () => {
    const bundle = buildLoopbackTools(baseDeps({ env: { MUSE_SEARCH_ENABLED: "false" } as LoopbackToolsDeps["env"] }));
    expect(bundle.search).toEqual([]);
  });

  it("respects MUSE_MATH_ENABLED=false (math is opt-out)", () => {
    const bundle = buildLoopbackTools(baseDeps({ env: { MUSE_MATH_ENABLED: "false" } as LoopbackToolsDeps["env"] }));
    expect(bundle.math).toEqual([]);
  });

  it("respects the MUSE_NOTES_ENABLED / MUSE_TASKS_ENABLED env flags", () => {
    const bundle = buildLoopbackTools(baseDeps({ env: { MUSE_NOTES_ENABLED: "false", MUSE_TASKS_ENABLED: "false" } as LoopbackToolsDeps["env"] }));
    expect(bundle.notes).toEqual([]);
    expect(bundle.tasks).toEqual([]);
  });

  it("exposes calendar tools only when the registry has a provider", () => {
    expect(buildLoopbackTools(baseDeps()).calendar).toEqual([]);
    const withProvider = buildLoopbackTools(baseDeps({ calendarRegistry: new CalendarProviderRegistry([calProvider()]) }));
    expect(withProvider.calendar.length).toBeGreaterThan(0);
  });

  it("exposes messaging tools only when there is a provider AND both poll functions (never an always-erroring tool)", () => {
    const provider = new MessagingProviderRegistry([msgProvider()]);
    expect(buildLoopbackTools(baseDeps({ messagingRegistry: provider })).messaging).toEqual([]); // no poll fns
    const wired = buildLoopbackTools(baseDeps({
      messagingRegistry: provider,
      pollAll: async () => ({ errors: [], ingestedByProvider: {} }),
      pollNow: async () => ({ ingested: 0 })
    }));
    expect(wired.messaging.length).toBeGreaterThan(0);
  });

  it("threads messagingApprovalGate into the agent's send — a DENY blocks the provider, an APPROVE lets it through", async () => {
    const sendProvider = (sent: unknown[]) => ({
      describe: () => ({ configured: true, displayName: "t", id: "tg" }),
      id: "tg",
      send: async (message: unknown) => { sent.push(message); return { destination: "@me", messageId: "x", providerId: "tg" }; }
    }) as never;
    const poll = { pollAll: async () => ({ errors: [], ingestedByProvider: {} }), pollNow: async () => ({ ingested: 0 }) };
    const findSend = (bundle: LoopbackToolsBundle) => bundle.messaging.find((t) => t.definition.name.endsWith("send"))!;

    const denied: unknown[] = [];
    const deniedBundle = buildLoopbackTools(baseDeps({ messagingApprovalGate: () => ({ approved: false, reason: "no" }), messagingRegistry: new MessagingProviderRegistry([sendProvider(denied)]), ...poll }));
    await findSend(deniedBundle).execute({ destination: "@me", text: "hi" }, {} as never);
    expect(denied).toHaveLength(0); // gate denied → provider.send never called

    const approved: unknown[] = [];
    const approvedBundle = buildLoopbackTools(baseDeps({ messagingApprovalGate: () => ({ approved: true }), messagingRegistry: new MessagingProviderRegistry([sendProvider(approved)]), ...poll }));
    await findSend(approvedBundle).execute({ destination: "@me", text: "hi" }, {} as never);
    expect(approved).toHaveLength(1); // gate approved → provider.send called
  });

  it("exposes the multi-provider registry surfaces only when ≥2 providers are registered", () => {
    expect(buildLoopbackTools(baseDeps({ notesRegistry: duckRegistry(1), tasksRegistry: duckRegistry(1) })).notesRegistry).toEqual([]);
    const multi = buildLoopbackTools(baseDeps({ notesRegistry: duckRegistry(2), tasksRegistry: duckRegistry(2) }));
    expect(multi.notesRegistry.length).toBeGreaterThan(0);
    expect(multi.tasksRegistry.length).toBeGreaterThan(0);
  });
});
