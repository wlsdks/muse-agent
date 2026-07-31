import { mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createLocalArtifactValidator,
  createLocalExactArtifactResolver,
  createPersonalThread,
  linkArtifact,
  openPreparedContinuityPack,
  readAttunementState,
  resolveContinuityInteractionOutboxFile
} from "@muse/attunement";
import { CalendarProviderRegistry } from "@muse/calendar";
import { MessagingProviderRegistry } from "@muse/messaging";
import { readTasks, writeTasks } from "@muse/stores";
import { describe, expect, it, vi } from "vitest";

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

  it("removes interactive public-web read and search tools under MUSE_LOCAL_ONLY=true before model projection", () => {
    const bundle = buildLoopbackTools(baseDeps({ env: { MUSE_LOCAL_ONLY: "true" } as LoopbackToolsDeps["env"] }));
    expect(bundle.webRead).toEqual([]);
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
    await findSend(deniedBundle).execute(
      { destination: "@me", effectId: "test-denied-send", text: "hi" },
      {} as never
    );
    expect(denied).toHaveLength(0); // gate denied → provider.send never called

    const approved: unknown[] = [];
    const approvedBundle = buildLoopbackTools(baseDeps({ messagingApprovalGate: () => ({ approved: true }), messagingRegistry: new MessagingProviderRegistry([sendProvider(approved)]), ...poll }));
    await findSend(approvedBundle).execute(
      { destination: "@me", effectId: "test-approved-send", text: "hi" },
      {} as never
    );
    expect(approved).toHaveLength(1); // gate approved → provider.send called
  });

  it("wires assembled muse.tasks.complete to factual Continuity evidence after a real open-to-done commit", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "muse-loopback-continuity-"));
    const tasksFile = join(testDir, "tasks.json");
    const attunementFile = join(testDir, "attunement.json");
    const notesDir = join(testDir, "notes");
    await writeTasks(tasksFile, [{
      createdAt: "2026-01-01T00:00:00.000Z", id: "task_mcp_evidence", status: "open", title: "MCP evidence"
    }]);
    const thread = await createPersonalThread(attunementFile, { kind: "work", title: "MCP root" });
    await linkArtifact(attunementFile, {
      artifactId: "task_mcp_evidence", artifactType: "task", role: "next-step", threadId: thread.id
    }, { validateArtifact: createLocalArtifactValidator({ notesDir, tasksFile }) });
    await openPreparedContinuityPack(
      attunementFile,
      thread.id,
      createLocalExactArtifactResolver({ notesDir, tasksFile }),
      { now: () => Date.parse("2026-01-02T00:00:00.000Z") }
    );
    const bundle = buildLoopbackTools(baseDeps({ attunementFile, notesDir, tasksFile }));
    const complete = bundle.tasks.find((tool) => tool.definition.name.endsWith("complete"));
    expect(complete).toBeDefined();

    await complete!.execute({ id: "task_mcp_evidence" }, {} as never);
    const state = await readAttunementState(attunementFile);
    expect(state.interactionReceipts).toHaveLength(1);
    expect(state.deliveries[0]?.outcome).toBeUndefined();
  });

  it("wires explicit Continuity Preview receipts into the configured fail-closed projector", async () => {
    const testDir = mkdtempSync(
      join(tmpdir(), "muse-loopback-attunegraph-projection-")
    );
    const attunementFile = join(testDir, "attunement.json");
    const notesDir = join(testDir, "notes");
    const tasksFile = join(testDir, "tasks.json");
    const thread = await createPersonalThread(attunementFile, {
      kind: "work",
      title: "AttuneGraph runtime projection"
    });
    const projectCurrentGraphObservation = vi.fn(async () => {
      throw new Error("private durable projection failure");
    });
    const bundle = buildLoopbackTools(baseDeps({
      attunementFile,
      notesDir,
      projectCurrentGraphObservation,
      tasksFile
    }));
    const preview = bundle.continuity.find((tool) =>
      tool.definition.name === "muse.continuity.pack.preview"
    );
    expect(preview).toBeDefined();

    const failed = await preview!.execute(
      { threadId: thread.id },
      {} as never
    ) as { readonly resume: { readonly reason?: string; readonly state?: string } };
    expect(failed.resume).toEqual(expect.objectContaining({
      reason: "graph-projection-failed",
      status: "unavailable"
    }));
    expect(projectCurrentGraphObservation).toHaveBeenCalledOnce();
    expect(projectCurrentGraphObservation.mock.calls[0]?.[0]).toMatchObject({
      authority: "caller-declared-observation",
      projection: {
        scope: {
          sourceId: "muse.local-attunement",
          threadId: thread.id
        }
      }
    });
  });

  it("shares one assembled coordinator between the Capsule service and tool", async () => {
    const testDir = mkdtempSync(
      join(tmpdir(), "muse-loopback-capsule-preparation-")
    );
    const attunementFile = join(testDir, "attunement.json");
    const notesDir = join(testDir, "notes");
    const tasksFile = join(testDir, "tasks.json");
    await writeTasks(tasksFile, [{
      createdAt: "2026-01-01T00:00:00.000Z",
      id: "task_capsule_assembly",
      status: "open",
      title: "Resume the assembled Capsule"
    }]);
    const thread = await createPersonalThread(attunementFile, {
      kind: "work",
      title: "Assembled Capsule"
    });
    await linkArtifact(attunementFile, {
      artifactId: "task_capsule_assembly",
      artifactType: "task",
      role: "next-step",
      threadId: thread.id
    }, {
      validateArtifact: createLocalArtifactValidator({
        notesDir,
        tasksFile
      })
    });
    const generate = vi.fn(async (request: unknown) => {
      const messages = (request as {
        readonly messages: readonly { readonly content: string }[];
      }).messages;
      const marker = "Prepare from this JSON DATA:\n";
      const content = messages[1]!.content;
      const body = JSON.parse(
        content.slice(content.indexOf(marker) + marker.length)
      ) as { readonly currentNextStepSourceKey: string };
      return {
        id: "assembled-capsule-response",
        model: "gemma4:12b",
        output: JSON.stringify({
          claims: [{
            text: "Review the exact assembled next step.",
            sourceKeys: [body.currentNextStepSourceKey]
          }],
          expectedMinutes: 9
        })
      };
    });
    const bundle = buildLoopbackTools(baseDeps({
      attunementFile,
      defaultModel: "ollama/gemma4:12b",
      modelProvider: {
        id: "ollama",
        generate
      } as never,
      notesDir,
      tasksFile
    }));
    const prepareTool = bundle.continuity.find((tool) =>
      tool.definition.name === "muse.continuity.capsule.prepare"
    );
    expect(prepareTool).toBeDefined();
    expect(bundle.continuity.filter((tool) =>
      tool.definition.name === "muse.continuity.capsule.prepare"
    )).toHaveLength(1);
    expect(bundle.continuityCapsulePreparation).toBeDefined();

    await expect(bundle.continuityCapsulePreparation!.prepare({
      locale: "en",
      threadId: thread.id
    })).resolves.toMatchObject({ status: "seeded" });
    await expect(prepareTool!.execute({
      locale: "en",
      threadId: thread.id
    }, {} as never)).resolves.toMatchObject({
      status: "ready",
      receipt: {
        requestedModel: "ollama/gemma4:12b",
        responseModel: "gemma4:12b"
      }
    });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("retries a pending loopback completion without rewriting the already-done task timestamp", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "muse-loopback-continuity-retry-"));
    const tasksFile = join(testDir, "tasks.json");
    const attunementFile = join(testDir, "attunement.json");
    const notesDir = join(testDir, "notes");
    await writeTasks(tasksFile, [{
      createdAt: "2026-01-01T00:00:00.000Z", id: "task_mcp_retry", status: "open", title: "MCP retry"
    }]);
    const thread = await createPersonalThread(attunementFile, { kind: "work", title: "MCP retry root" });
    await linkArtifact(attunementFile, {
      artifactId: "task_mcp_retry", artifactType: "task", role: "next-step", threadId: thread.id
    }, { validateArtifact: createLocalArtifactValidator({ notesDir, tasksFile }) });
    await openPreparedContinuityPack(
      attunementFile,
      thread.id,
      createLocalExactArtifactResolver({ notesDir, tasksFile }),
      { now: () => Date.parse("2026-01-02T00:00:00.000Z") }
    );
    const validBytes = await readFile(attunementFile, "utf8");
    await writeFile(attunementFile, "{\"invalid\":true}\n");
    const bundle = buildLoopbackTools(baseDeps({ attunementFile, notesDir, tasksFile }));
    const complete = bundle.tasks.find((tool) => tool.definition.name.endsWith("complete"));
    expect(complete).toBeDefined();

    await complete!.execute({ id: "task_mcp_retry" }, {} as never);
    const completedAt = (await readTasks(tasksFile))[0]?.completedAt;
    expect(completedAt).toBeDefined();

    await writeFile(attunementFile, validBytes);
    await complete!.execute({ id: "task_mcp_retry" }, {} as never);
    expect((await readTasks(tasksFile))[0]?.completedAt).toBe(completedAt);
    const state = await readAttunementState(attunementFile);
    expect(state.interactionReceipts).toHaveLength(1);
    expect(state.deliveries[0]?.outcome).toBeUndefined();
  });

  it("surfaces a loopback prepare error and leaves the task open when the outbox is corrupt", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "muse-loopback-continuity-corrupt-"));
    const tasksFile = join(testDir, "tasks.json");
    const attunementFile = join(testDir, "attunement.json");
    const outboxFile = resolveContinuityInteractionOutboxFile(attunementFile);
    const corruptBytes = "{\"schemaVersion\":999,\"entries\":[]}\n";
    await writeTasks(tasksFile, [{
      createdAt: "2026-01-01T00:00:00.000Z", id: "task_mcp_corrupt", status: "open", title: "MCP corrupt"
    }]);
    await writeFile(outboxFile, corruptBytes);
    const bundle = buildLoopbackTools(baseDeps({ attunementFile, tasksFile }));
    const complete = bundle.tasks.find((tool) => tool.definition.name.endsWith("complete"));
    const result = await complete!.execute({ id: "task_mcp_corrupt" }, {} as never) as { readonly error?: string };

    expect(result.error).toContain("outbox");
    expect((await readTasks(tasksFile))[0]).toMatchObject({ id: "task_mcp_corrupt", status: "open" });
    expect(await readFile(outboxFile, "utf8")).toBe(corruptBytes);
  });

  it("consent pin: MUSE_APPLE_REMINDERS_MIRROR absent ⇒ no Apple mirror is wired (add produces no mirrorNote, zero osascript)", async () => {
    const findAdd = (bundle: LoopbackToolsBundle) =>
      bundle.reminders.find((t) => t.definition.name.endsWith("add"))!;
    // env is {} in baseDeps → the mirror is never injected, so `add` cannot
    // reach osascript. Executing it on a real (non-macOS-touching) tmp store.
    const bundle = buildLoopbackTools(baseDeps());
    const out = (await findAdd(bundle).execute(
      { text: "milk", dueAt: "2026-06-11T00:00:00.000Z" },
      {} as never
    )) as { reminder?: unknown; mirrorNote?: string };
    expect(out.reminder).toBeDefined();
    expect(out.mirrorNote).toBeUndefined();
  });

  it("consent pin: MUSE_APPLE_NOTES_MIRROR absent ⇒ no Apple Notes mirror is wired (save produces no mirrorNote, zero osascript)", async () => {
    const findSave = (bundle: LoopbackToolsBundle) =>
      bundle.notes.find((t) => t.definition.name.endsWith("save"))!;
    // env is {} in baseDeps → the mirror is never injected, so a `save` create
    // cannot reach osascript. Writes to a real (non-macOS-touching) tmp notes dir.
    const bundle = buildLoopbackTools(baseDeps());
    const out = (await findSave(bundle).execute(
      { content: "hi", path: "consent-pin.md" },
      {} as never
    )) as { created?: boolean; mirrorNote?: string };
    expect(out.created).toBe(true);
    expect(out.mirrorNote).toBeUndefined();
  });

  it("exposes the multi-provider registry surfaces only when ≥2 providers are registered", () => {
    expect(buildLoopbackTools(baseDeps({ notesRegistry: duckRegistry(1), tasksRegistry: duckRegistry(1) })).notesRegistry).toEqual([]);
    const multi = buildLoopbackTools(baseDeps({ notesRegistry: duckRegistry(2), tasksRegistry: duckRegistry(2) }));
    expect(multi.notesRegistry.length).toBeGreaterThan(0);
    expect(multi.tasksRegistry.length).toBeGreaterThan(0);
  });
});
