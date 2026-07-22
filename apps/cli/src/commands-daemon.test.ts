import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { readBrowsingStore } from "@muse/recall";

import { LogMessagingProvider, MessagingProviderRegistry, type MessagingProvider, type OutboundMessage, type OutboundReceipt } from "@muse/messaging";
import { writeDayRhythmConfig } from "@muse/autoconfigure";
import { appendDigestItem, enqueueLearnEvent, readDigestQueue, readPendingLearnEvents, readPlaybook, readProactiveHeartbeat, readProposedActions, readReflections, setLearningPaused, writeEpisodes, writeFollowups, writeObjectives, writePlaybook, type PersistedEpisode } from "@muse/stores";
import { buildCheckinQuestion, writeCheckins, type PersistedCheckin } from "@muse/proactivity";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MuseTool } from "@muse/tools";

import { buildLaunchAgentPlist, chromeSnapshotConnectionFromTools, DaemonStopSignal, parseLaunchctlListInfo, registerDaemonCommands, runDaemonLoop, validateDaemonCliEntry, type DaemonHelpers } from "./commands-daemon.js";
import type { DaemonResourceSnapshot } from "./daemon-resource-admission.js";
import type { DaemonResourceReceipt } from "./daemon-resource-receipt.js";

const TEST_HARNESS_CLI_ENTRY = fileURLToPath(import.meta.url);

function fakeChromeTools(snapshotText: string): MuseTool[] {
  const mk = (name: string, result: string): MuseTool => ({
    definition: { description: "", inputSchema: {}, name: `chrome-devtools.${name}`, risk: "read" },
    execute: async () => result
  } as unknown as MuseTool);
  return [mk("navigate_page", "ok"), mk("take_snapshot", snapshotText)];
}

function capturingProvider(sent: OutboundMessage[], id = "telegram"): MessagingProvider {
  return {
    describe: () => ({ description: "t", displayName: "T", id }),
    id,
    async send(message: OutboundMessage): Promise<OutboundReceipt> {
      sent.push(message);
      return { destination: message.destination, messageId: "m1", providerId: id };
    }
  };
}

// A model that synthesizes a fixed followup message — the real
// runtime assembly is never built, so the smoke is hermetic.
function fakeFollowupModel(): NonNullable<Awaited<ReturnType<NonNullable<DaemonHelpers["resolveFollowupModel"]>>>> {
  return {
    model: "test-model",
    modelProvider: { generate: async () => ({ output: "Quick check on the Q3 memo — any blockers?" }) } as never
  };
}

async function runDaemon(
  args: string[],
  opts: { env: NodeJS.ProcessEnv; registry: MessagingProviderRegistry; buildCalendarRegistry?: DaemonHelpers["buildCalendarRegistry"]; buildMessagingRegistry?: DaemonHelpers["buildMessagingRegistry"]; readDaemonConfig?: DaemonHelpers["readDaemonConfig"]; runDaemonLoop?: DaemonHelpers["runDaemonLoop"]; resolveFollowupModel?: DaemonHelpers["resolveFollowupModel"]; resolveKnowledgeEnrich?: DaemonHelpers["resolveKnowledgeEnrich"]; resolveChromeConnection?: DaemonHelpers["resolveChromeConnection"]; fetchImpl?: typeof globalThis.fetch; ambientMacosRun?: DaemonHelpers["ambientMacosRun"]; chromeConnection?: DaemonHelpers["chromeConnection"]; knowledgeEnrich?: DaemonHelpers["knowledgeEnrich"]; briefingCalendarLister?: DaemonHelpers["briefingCalendarLister"]; selfLearnDistill?: DaemonHelpers["selfLearnDistill"]; contradictionClassify?: DaemonHelpers["contradictionClassify"]; emailSyncProvider?: DaemonHelpers["emailSyncProvider"]; makeEmailSyncTick?: DaemonHelpers["makeEmailSyncTick"]; messagingPoll?: DaemonHelpers["messagingPoll"]; consolidateMerge?: DaemonHelpers["consolidateMerge"]; consolidateValidate?: DaemonHelpers["consolidateValidate"]; conflictWatchCalendarLister?: DaemonHelpers["conflictWatchCalendarLister"]; browsingSync?: DaemonHelpers["browsingSync"]; resourceSnapshot?: DaemonHelpers["resourceSnapshot"]; writeResourceAdmissionReceipt?: DaemonHelpers["writeResourceAdmissionReceipt"]; schtasksRun?: DaemonHelpers["schtasksRun"]; runLaunchctl?: DaemonHelpers["runLaunchctl"]; platform?: DaemonHelpers["platform"]; daemonCliEntry?: DaemonHelpers["daemonCliEntry"]; daemonTemporaryRoots?: DaemonHelpers["daemonTemporaryRoots"] }
): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  // configDir isolates language resolution (--status now resolves the CLI
  // language via cli-i18n) from the REAL ~/.config/muse/config.json — a
  // dev box with `language: "ko"` there would otherwise cache Korean for
  // the rest of the process and break every English assertion below.
  const io = { configDir: mkdtempSync(join(tmpdir(), "muse-daemon-cfg-")), stderr: (m: string) => stderr.push(m), stdout: (m: string) => stdout.push(m) };
  const prevExit = process.exitCode;
  let exitCode: number | undefined;
  try {
    const program = new Command();
    program.exitOverride();
    registerDaemonCommands(program, io, {
      buildMessagingRegistry: opts.buildMessagingRegistry ?? (() => opts.registry),
      ...(opts.buildCalendarRegistry ? { buildCalendarRegistry: opts.buildCalendarRegistry } : {}),
      ...(opts.readDaemonConfig ? { readDaemonConfig: opts.readDaemonConfig } : {}),
      env: () => opts.env,
      ...(opts.resolveKnowledgeEnrich ? { resolveKnowledgeEnrich: opts.resolveKnowledgeEnrich } : {}),
      ...(opts.resolveChromeConnection ? { resolveChromeConnection: opts.resolveChromeConnection } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.ambientMacosRun ? { ambientMacosRun: opts.ambientMacosRun } : {}),
      ...(opts.chromeConnection ? { chromeConnection: opts.chromeConnection } : {}),
      ...(opts.knowledgeEnrich ? { knowledgeEnrich: opts.knowledgeEnrich } : {}),
      ...(opts.briefingCalendarLister ? { briefingCalendarLister: opts.briefingCalendarLister } : {}),
      ...(opts.selfLearnDistill ? { selfLearnDistill: opts.selfLearnDistill } : {}),
      ...(opts.contradictionClassify ? { contradictionClassify: opts.contradictionClassify } : {}),
      ...(opts.emailSyncProvider ? { emailSyncProvider: opts.emailSyncProvider } : {}),
      ...(opts.makeEmailSyncTick ? { makeEmailSyncTick: opts.makeEmailSyncTick } : {}),
      ...(opts.runDaemonLoop ? { runDaemonLoop: opts.runDaemonLoop } : {}),
      ...(opts.messagingPoll ? { messagingPoll: opts.messagingPoll } : {}),
      ...(opts.consolidateMerge ? { consolidateMerge: opts.consolidateMerge } : {}),
      ...(opts.consolidateValidate ? { consolidateValidate: opts.consolidateValidate } : {}),
      ...(opts.conflictWatchCalendarLister ? { conflictWatchCalendarLister: opts.conflictWatchCalendarLister } : {}),
      ...(opts.browsingSync ? { browsingSync: opts.browsingSync } : {}),
      resourceSnapshot: opts.resourceSnapshot ?? (() => ({
        cpuCount: 8,
        freeMemoryBytes: 4 * 1024 * 1024 * 1024,
        load1: 1,
        processCpuSystemMicros: 0,
        processCpuUserMicros: 0,
        residentMemoryBytes: 128 * 1024 * 1024,
        thermalState: "unavailable"
      })),
      ...(opts.writeResourceAdmissionReceipt ? { writeResourceAdmissionReceipt: opts.writeResourceAdmissionReceipt } : {}),
      ...(opts.schtasksRun ? { schtasksRun: opts.schtasksRun } : {}),
      runLaunchctl: opts.runLaunchctl ?? (async () => ({ code: 1, stderr: "Could not find specified service", stdout: "" })),
      ...(opts.platform ? { platform: opts.platform } : {}),
      daemonCliEntry: opts.daemonCliEntry ?? TEST_HARNESS_CLI_ENTRY,
      ...(opts.daemonTemporaryRoots ? { daemonTemporaryRoots: opts.daemonTemporaryRoots } : {}),
      // Default: followup tick disabled (no model) so proactive cases stay hermetic.
      resolveFollowupModel: opts.resolveFollowupModel ?? (async () => undefined)
    });
    await program.parseAsync(["node", "muse", "daemon", ...args]);
    exitCode = process.exitCode === undefined ? undefined : Number(process.exitCode);
  } catch (cause) {
    exitCode = (cause as { exitCode?: number }).exitCode ?? 1;
  } finally {
    process.exitCode = prevExit;
  }
  return { exitCode, stderr: stderr.join(""), stdout: stdout.join("") };
}

function tmpEnv(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "muse-daemon-"));
  return {
    HOME: dir,
    MUSE_AMBIENT_FILE: join(dir, "ambient.json"),
    MUSE_BRIEFING_SIDECAR_FILE: join(dir, "briefing-fired.json"),
    MUSE_CHANNEL_OWNERS_FILE: join(dir, "channel-owners.json"),
    MUSE_CLI_CONFIG_FILE: join(dir, "config.json"),
    MUSE_CONTACTS_FILE: join(dir, "contacts.json"),
    MUSE_DAEMON_CONFIG_FILE: join(dir, "daemon.json"),
    MUSE_DIGEST_QUEUE_FILE: join(dir, "digest-queue.json"),
    MUSE_DIGEST_SENT_FILE: join(dir, "digest-sent.json"),
    MUSE_FOLLOWUPS_FILE: join(dir, "followups.json"),
    MUSE_INTERRUPTION_LEDGER_FILE: join(dir, "interruption-ledger.json"),
    MUSE_OBJECTIVES_FILE: join(dir, "objectives.json"),
    MUSE_PROACTIVE_HISTORY_FILE: join(dir, "history.json"),
    MUSE_PROACTIVE_SIDECAR_FILE: join(dir, "fired.json"),
    MUSE_PROPOSED_ACTIONS_FILE: join(dir, "proposed.json"),
    MUSE_REMINDERS_FILE: join(dir, "reminders.json"),
    MUSE_TASKS_FILE: join(dir, "tasks.json"),
    MUSE_LEARN_QUEUE_FILE: join(dir, "learn-queue.jsonl"),
    MUSE_LAST_PROACTIVE_FILE: join(dir, "last-proactive-delivery.json"),
    MUSE_PLAYBOOK_FILE: join(dir, "playbook.json"),
    MUSE_LEARNING_PAUSE_FILE: join(dir, "learning-paused.json"),
    MUSE_SUPPRESSED_LESSONS_FILE: join(dir, "suppressed.json")
  };
}

describe("muse daemon — one-process launcher fires real ticks", () => {
  it("--once delivers an imminent task to the contract-faithful messaging sink", async () => {
    const env = tmpEnv();
    const dueSoon = new Date(Date.now() + 5 * 60_000).toISOString();
    writeFileSync(env.MUSE_TASKS_FILE!, JSON.stringify({
      tasks: [{ id: "t1", title: "Ship the memo", status: "open", dueAt: dueSoon, createdAt: "2026-01-01T00:00:00Z" }]
    }), "utf8");
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);

    const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], { env, registry });

    expect(res.exitCode).toBeUndefined();
    expect(res.stdout).toContain("daemon --once complete");
    expect(res.stdout).toMatch(/proactive: fired 1\/1 imminent/);
    expect(res.stdout).toContain("followup: skipped");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.destination).toBe("555");
    expect(sent[0]!.text).toContain("Ship the memo");
  });

  it("--once with no imminent task fires nothing (quiet tick, no send)", async () => {
    const env = tmpEnv();
    const dueFar = new Date(Date.now() + 30 * 86_400_000).toISOString();
    writeFileSync(env.MUSE_TASKS_FILE!, JSON.stringify({
      tasks: [{ id: "t1", title: "Later", status: "open", dueAt: dueFar, createdAt: "2026-01-01T00:00:00Z" }]
    }), "utf8");
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);

    const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], { env, registry });

    expect(res.exitCode).toBeUndefined();
    expect(res.stdout).toMatch(/proactive: fired 0\/0 imminent/);
    expect(sent).toHaveLength(0);
  });

  it("--once also fires a DUE reminder through the same launcher + sink", async () => {
    const env: NodeJS.ProcessEnv = { ...tmpEnv(), MUSE_DAEMON_DELIVERY_ENABLED: "true" };
    writeFileSync(env.MUSE_TASKS_FILE!, JSON.stringify({ tasks: [] }), "utf8");
    writeFileSync(env.MUSE_REMINDERS_FILE!, JSON.stringify({
      reminders: [
        { id: "rem1", text: "Take the bread out of the oven", status: "pending", dueAt: "1970-01-01T00:00:00Z", createdAt: "2026-01-01T00:00:00Z" },
        { id: "rem2", text: "Pay rent", status: "pending", dueAt: "2030-01-01T00:00:00Z", createdAt: "2026-01-01T00:00:00Z" }
      ]
    }), "utf8");
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);

    const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], { env, registry });

    expect(res.exitCode).toBeUndefined();
    expect(res.stdout).toMatch(/reminders: fired 1\/1 due/);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("Take the bread out of the oven");
  });

  it("provider lock rejects a reminder's per-record non-log route at the shared daemon send chokepoint", async () => {
    const env: NodeJS.ProcessEnv = { ...tmpEnv(), MUSE_DAEMON_PROVIDER_LOCK: "log" };
    writeFileSync(env.MUSE_TASKS_FILE!, JSON.stringify({ tasks: [] }), "utf8");
    writeFileSync(env.MUSE_REMINDERS_FILE!, JSON.stringify({
      reminders: [{
        createdAt: "2026-01-01T00:00:00Z",
        dueAt: "1970-01-01T00:00:00Z",
        id: "rem-override",
        status: "pending",
        text: "must stay local",
        via: { destination: "external", providerId: "telegram" }
      }]
    }), "utf8");
    const logSent: OutboundMessage[] = [];
    const telegramSent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([
      capturingProvider(logSent, "log"),
      capturingProvider(telegramSent)
    ]);

    const result = await runDaemon(["--once", "--provider", "log"], { env, registry });

    expect(result.stdout).toMatch(/provider lock/iu);
    expect(logSent).toHaveLength(0);
    expect(telegramSent).toHaveLength(0);
  });

  it("--once also fires a DUE followup through the same launcher + sink", async () => {
    const env = tmpEnv();
    writeFileSync(env.MUSE_TASKS_FILE!, JSON.stringify({ tasks: [] }), "utf8");
    await writeFollowups(env.MUSE_FOLLOWUPS_FILE!, [
      { createdAt: "2026-01-01T00:00:00Z", id: "fu1", scheduledFor: "2026-01-02T00:00:00Z", status: "scheduled", summary: "Check the Q3 memo", userId: "stark" }
    ]);
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);

    const res = await runDaemon(
      ["--once", "--provider", "telegram", "--destination", "555"],
      { env, registry, resolveFollowupModel: async () => fakeFollowupModel() }
    );

    expect(res.exitCode).toBeUndefined();
    expect(res.stdout).toMatch(/followup: fired 1\/1 due/);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("Q3 memo");
  });

  it("--once delivers a matching AMBIENT rule through the same launcher + sink", async () => {
    const env: NodeJS.ProcessEnv = { ...tmpEnv(), MUSE_AMBIENT_RULES: JSON.stringify([
      { id: "focus_slack", title: "Heads up", message: "You're in Slack", match: { app: "Slack" } }
    ]) };
    writeFileSync(env.MUSE_TASKS_FILE!, JSON.stringify({ tasks: [] }), "utf8");
    writeFileSync(env.MUSE_AMBIENT_FILE!, JSON.stringify({ app: "Slack", window: "general" }), "utf8");
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);

    const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], { env, registry });

    expect(res.exitCode).toBeUndefined();
    expect(res.stdout).toMatch(/ambient: delivered 1/);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("You're in Slack");
  });

  it("--once drives the REAL macOS active-window source when MUSE_AMBIENT_SOURCE=macos", async () => {
    const env: NodeJS.ProcessEnv = { ...tmpEnv(), MUSE_AMBIENT_SOURCE: "macos", MUSE_AMBIENT_RULES: JSON.stringify([
      { id: "focus_slack", title: "Heads up", message: "You're in Slack", match: { app: "Slack" } }
    ]) };
    writeFileSync(env.MUSE_TASKS_FILE!, JSON.stringify({ tasks: [] }), "utf8");
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);

    // Contract-faithful osascript: line 1 = frontmost app, line 2 = window title.
    const res = await runDaemon(
      ["--once", "--provider", "telegram", "--destination", "555"],
      { ambientMacosRun: async () => "Slack\ngeneral", env, registry }
    );

    expect(res.stdout).toContain("ambient source: macOS active window");
    expect(res.stdout).toMatch(/ambient: delivered 1/);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("You're in Slack");
  });

  it("--once drives the Windows active-window source when MUSE_AMBIENT_SOURCE=windows", async () => {
    const env: NodeJS.ProcessEnv = { ...tmpEnv(), MUSE_AMBIENT_SOURCE: "windows", MUSE_AMBIENT_RULES: JSON.stringify([
      { id: "focus_word", title: "Heads up", message: "You're writing the memo", match: { app: "WINWORD" } }
    ]) };
    writeFileSync(env.MUSE_TASKS_FILE!, JSON.stringify({ tasks: [] }), "utf8");
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);

    // Contract-faithful PowerShell: line 1 = frontmost process, line 2 = window title.
    const res = await runDaemon(
      ["--once", "--provider", "telegram", "--destination", "555"],
      { ambientMacosRun: async () => "WINWORD\nQ3 memo.docx - Word", env, registry }
    );

    expect(res.stdout).toContain("ambient source: Windows active window");
    expect(res.stdout).toMatch(/ambient: delivered 1/);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("You're writing the memo");
  });

  it("--once enriches a fired ambient notice with a Related line from the user's knowledge", async () => {
    const env: NodeJS.ProcessEnv = { ...tmpEnv(), MUSE_AMBIENT_RULES: JSON.stringify([
      { id: "focus_slack", title: "Heads up", message: "You're in Slack", match: { app: "Slack" } }
    ]) };
    writeFileSync(env.MUSE_TASKS_FILE!, JSON.stringify({ tasks: [] }), "utf8");
    writeFileSync(env.MUSE_AMBIENT_FILE!, JSON.stringify({ app: "Slack", window: "Q3 budget channel" }), "utf8");
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);
    // Stands in for createKnowledgeEnricher — the daemon just needs the seam.
    const knowledgeEnrich = async (query: string) => `you noted the Q3 memo is due Friday (cue: ${query})`;

    const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], { env, knowledgeEnrich, registry });

    expect(res.exitCode).toBeUndefined();
    expect(res.stdout).toMatch(/ambient: delivered 1/);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("You're in Slack");
    expect(sent[0]!.text).toContain("Related: you noted the Q3 memo is due Friday");
  });

  it("ambient tick is skipped when no rules are configured (hermetic default)", async () => {
    const env = tmpEnv();
    writeFileSync(env.MUSE_TASKS_FILE!, JSON.stringify({ tasks: [] }), "utf8");
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);

    const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], { env, registry });

    expect(res.stdout).toContain("ambient: skipped (no rules)");
    expect(sent).toHaveLength(0);
  });

  it("--once fires a WEB-WATCH trigger through the same launcher + sink", async () => {
    const env: NodeJS.ProcessEnv = { ...tmpEnv(), MUSE_WEB_WATCH_CONFIG: JSON.stringify([
      { id: "w1", url: "https://shop.example/item", title: "Stock", message: "The item is sold out", rule: { appears: "SOLD OUT" } }
    ]) };
    writeFileSync(env.MUSE_TASKS_FILE!, JSON.stringify({ tasks: [] }), "utf8");
    const fetchImpl = (async () => new Response("Status: SOLD OUT", { status: 200 })) as unknown as typeof globalThis.fetch;
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);

    const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], { env, fetchImpl, registry });

    expect(res.exitCode).toBeUndefined();
    expect(res.stdout).toMatch(/web-watch: delivered 1/);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("sold out");
  });

  it("--once drives a source:chrome web-watch through an injected Chrome connection", async () => {
    const env: NodeJS.ProcessEnv = { ...tmpEnv(), MUSE_WEB_WATCH_CONFIG: JSON.stringify([
      { id: "w1", url: "https://orders.example/123", title: "Order", message: "Your order shipped", source: "chrome", rule: { appears: "SHIPPED" } }
    ]) };
    writeFileSync(env.MUSE_TASKS_FILE!, JSON.stringify({ tasks: [] }), "utf8");
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);
    // Contract-faithful Chrome DevTools MCP: navigate_page then take_snapshot returns the page text.
    const chromeConnection: NonNullable<DaemonHelpers["chromeConnection"]> = {
      callTool: async (toolName) => (toolName === "take_snapshot" ? "Order status: SHIPPED" : undefined)
    };

    const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], { chromeConnection, env, registry });

    expect(res.exitCode).toBeUndefined();
    expect(res.stdout).toMatch(/web-watch: delivered 1/);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("order shipped");
  });

  it("a source:chrome watch with NO Chrome connection is skipped (fail-soft) — daemon stays up", async () => {
    const env: NodeJS.ProcessEnv = { ...tmpEnv(), MUSE_WEB_WATCH_CONFIG: JSON.stringify([
      { id: "w1", url: "https://orders.example/123", title: "Order", message: "Your order shipped", source: "chrome", rule: { appears: "SHIPPED" } }
    ]) };
    writeFileSync(env.MUSE_TASKS_FILE!, JSON.stringify({ tasks: [] }), "utf8");
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);

    const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], { env, registry });

    expect(res.exitCode).toBeUndefined();
    expect(res.stdout).toContain("web-watch: skipped (no config)");
    expect(sent).toHaveLength(0);
  });

  it("--once fires a HOME-WATCH on a Home Assistant entity state through the same launcher + sink", async () => {
    const env: NodeJS.ProcessEnv = { ...tmpEnv(),
      MUSE_HOME_WATCH_CONFIG: JSON.stringify([
        { id: "door", entityId: "lock.front_door", title: "Door", message: "the front door is unlocked", rule: { appears: "unlocked" } }
      ]),
      MUSE_HOMEASSISTANT_URL: "http://ha.local:8123",
      MUSE_HOMEASSISTANT_TOKEN: "ha-token"
    };
    writeFileSync(env.MUSE_TASKS_FILE!, JSON.stringify({ tasks: [] }), "utf8");
    // Contract-faithful HA REST: GET /api/states/<entity> → { state }.
    const fetchImpl = (async () => new Response(JSON.stringify({ entity_id: "lock.front_door", state: "unlocked" }), { status: 200 })) as unknown as typeof globalThis.fetch;
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);

    const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], { env, fetchImpl, registry });

    expect(res.exitCode).toBeUndefined();
    expect(res.stdout).toMatch(/home-watch: delivered 1/);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("the front door is unlocked");
  });

  it("home-watch tick is skipped when no config / HA creds are set (hermetic default)", async () => {
    const env = tmpEnv();
    writeFileSync(env.MUSE_TASKS_FILE!, JSON.stringify({ tasks: [] }), "utf8");
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);

    const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], { env, registry });

    expect(res.stdout).toContain("home-watch: skipped (no config)");
    expect(sent).toHaveLength(0);
  });

  it("web-watch tick is skipped when no config is set (hermetic default)", async () => {
    const env = tmpEnv();
    writeFileSync(env.MUSE_TASKS_FILE!, JSON.stringify({ tasks: [] }), "utf8");
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);

    const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], { env, registry });

    expect(res.stdout).toContain("web-watch: skipped (no config)");
    expect(sent).toHaveLength(0);
  });

  it("--once fires a MET standing objective through the same launcher + sink", async () => {
    const env = tmpEnv();
    writeFileSync(env.MUSE_TASKS_FILE!, JSON.stringify({
      tasks: [{ createdAt: "2026-01-01T00:00:00Z", id: "t1", status: "open", title: "build went green" }]
    }), "utf8");
    await writeObjectives(env.MUSE_OBJECTIVES_FILE!, [
      { attempts: 0, createdAt: "2026-01-01T00:00:00Z", id: "obj1", kind: "watch", spec: "ping me when the build is green", status: "active", userId: "stark" }
    ]);
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);
    const metModel: DaemonHelpers["resolveFollowupModel"] = async () => ({
      model: "test-model",
      modelProvider: { generate: async () => ({ output: '{"store":"tasks","keywords":["green"]}' }) } as never
    });

    const res = await runDaemon(
      ["--once", "--provider", "telegram", "--destination", "555"],
      { env, registry, resolveFollowupModel: metModel }
    );

    expect(res.exitCode).toBeUndefined();
    expect(res.stdout).toMatch(/objectives: 1 fired/);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("Objective met: ping me when the build is green");
    expect(sent[0]!.text).toContain("evidence: task:build went green");
  });

  it("--once with MUSE_OBJECTIVES_PROPOSE proposes a met objective instead of sending it", async () => {
    const env: NodeJS.ProcessEnv = { ...tmpEnv(), MUSE_OBJECTIVES_PROPOSE: "true" };
    writeFileSync(env.MUSE_TASKS_FILE!, JSON.stringify({
      tasks: [{ createdAt: "2026-01-01T00:00:00Z", id: "t1", status: "open", title: "build went green" }]
    }), "utf8");
    await writeObjectives(env.MUSE_OBJECTIVES_FILE!, [
      { attempts: 0, createdAt: "2026-01-01T00:00:00Z", id: "obj1", kind: "watch", spec: "ping me when the build is green", status: "active", userId: "stark" }
    ]);
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);
    const metModel: DaemonHelpers["resolveFollowupModel"] = async () => ({
      model: "test-model",
      modelProvider: { generate: async () => ({ output: '{"store":"tasks","keywords":["green"]}' }) } as never
    });

    const res = await runDaemon(
      ["--once", "--provider", "telegram", "--destination", "555"],
      { env, registry, resolveFollowupModel: metModel }
    );

    expect(res.exitCode).toBeUndefined();
    expect(res.stdout).toMatch(/objectives: 1 fired/);
    // draft-first: NOTHING was sent — a proposal is waiting for confirmation
    expect(sent).toHaveLength(0);
    const proposals = await readProposedActions(env.MUSE_PROPOSED_ACTIONS_FILE!);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.status).toBe("pending");
    expect(proposals[0]!.text).toContain("ping me when the build is green");
  });

  it("objectives tick is skipped when no model resolves (hermetic default)", async () => {
    const env = tmpEnv();
    writeFileSync(env.MUSE_TASKS_FILE!, JSON.stringify({ tasks: [] }), "utf8");
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);

    const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], { env, registry });

    expect(res.stdout).toContain("objectives: skipped (no model resolved)");
    expect(sent).toHaveLength(0);
  });

  it("--status reports proactive enabled and the rest disabled on a bare config", async () => {
    const env = tmpEnv();
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);

    const res = await runDaemon(["--status", "--provider", "telegram", "--destination", "555"], { env, registry });

    expect(res.exitCode).toBeUndefined();
    expect(res.stdout).toContain("proactive:  enabled");
    expect(res.stdout).toContain("followup:   disabled");
    expect(res.stdout).toContain("ambient:    disabled");
    expect(res.stdout).toContain("web-watch:  disabled");
    expect(res.stdout).toContain("objectives: disabled");
    expect(sent).toHaveLength(0);
  });

  it("--status exposes the master delivery brake and log-only provider lock", async () => {
    const env: NodeJS.ProcessEnv = {
      ...tmpEnv(),
      MUSE_DAEMON_DELIVERY_ENABLED: "false",
      MUSE_DAEMON_PROVIDER_LOCK: "log"
    };
    const registry = new MessagingProviderRegistry([capturingProvider([], "log")]);

    const result = await runDaemon(["--status", "--provider", "log"], { env, registry });

    expect(result.stdout).toContain("delivery:   heartbeat-only (brake engaged)");
    expect(result.stdout).toContain("route-lock: log-only");
  });

  it("--status groups the optional-feature lines under a header and states what each feature DOES, not just the raw env var (E4b audit #3/#9)", async () => {
    const env = tmpEnv();
    const registry = new MessagingProviderRegistry([capturingProvider([])]);

    const res = await runDaemon(["--status", "--provider", "telegram", "--destination", "555"], { env, registry });

    expect(res.stdout).toContain("features you can turn on:");
    expect(res.stdout).toContain("ambient:    disabled — ambient rules watch background context and file continuous notices — set MUSE_AMBIENT_RULES to a rules file to turn it on");
    expect(res.stdout).toContain("web-watch:  disabled — web-watch checks configured pages for changes and notifies you — set MUSE_WEB_WATCH_CONFIG to turn it on");
    expect(res.stdout).toContain("digest:     enabled");
  });

  it("--status does not call an existing plist healthy when launchd has no registered job", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-autostart-"));
    const plistFile = join(dir, "com.muse.daemon.plist");
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);

    writeFileSync(plistFile, buildLaunchAgentPlist({
      label: "com.muse.daemon",
      programArguments: [process.execPath, process.argv[1]!, "daemon"],
      stderrPath: join(dir, "daemon.err.log"),
      stdoutPath: join(dir, "daemon.out.log")
    }), "utf8");

    const status = await runDaemon(
      ["--status", "--provider", "telegram", "--destination", "555"],
      {
        env: { ...tmpEnv(), MUSE_DAEMON_PLIST_FILE: plistFile },
        platform: "darwin",
        registry,
        runLaunchctl: async () => ({ code: 1, stderr: "Could not find specified service", stdout: "" })
      }
    );
    expect(status.stdout).toContain("artifact:     valid");
    expect(status.stdout).toContain("runtime:      not registered");
    expect(status.stdout).not.toMatch(/autostart:\s+installed/);
  });

  it("--status reports contained resident safety gates instead of conflicting shell settings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-status-contained-safety-"));
    const plistFile = join(dir, "com.muse.daemon.plist");
    writeFileSync(plistFile, buildLaunchAgentPlist({
      environmentVariables: {
        MUSE_DAEMON_DELIVERY_ENABLED: "false",
      MUSE_DAEMON_HEAVY_WORK_UNITS_PER_TICK: "2",
        MUSE_DAEMON_PROVIDER_LOCK: "log",
        MUSE_SELFLEARN_ENABLED: "false"
      },
      label: "com.muse.daemon",
      programArguments: [process.execPath, process.argv[1]!, "daemon"],
      stderrPath: join(dir, "daemon.err.log"),
      stdoutPath: join(dir, "daemon.out.log")
    }), "utf8");

    const status = await runDaemon(["--status"], {
      env: {
        ...tmpEnv(),
        MUSE_DAEMON_DELIVERY_ENABLED: "true",
        MUSE_DAEMON_PLIST_FILE: plistFile,
        MUSE_DAEMON_PROVIDER_LOCK: "",
        MUSE_SELFLEARN_ENABLED: "true"
      },
      platform: "darwin",
      registry: new MessagingProviderRegistry([capturingProvider([], "log")]),
      runLaunchctl: async () => ({ code: 0, stderr: "", stdout: '{\n\t"PID" = 731;\n};\n' })
    });

    expect(status.stdout).toContain("safety=resident LaunchAgent");
    expect(status.stdout).toContain("delivery:   heartbeat-only (brake engaged)");
    expect(status.stdout).toContain("route-lock: log-only");
    expect(status.stdout).toContain("proactive:  blocked (delivery brake engaged)");
    expect(status.stdout).toContain("resident execution: heartbeat-only; all remaining lines describe configured features, not running ticks");
    expect(status.stdout).toContain("configured features (held by delivery brake):");
    expect(status.stdout).toContain("self-learn: disabled (safety gate)");
  });

  it("--status uses launchd defaults for absent contained safety keys, never the shell", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-status-contained-defaults-"));
    const plistFile = join(dir, "com.muse.daemon.plist");
    writeFileSync(plistFile, buildLaunchAgentPlist({
      label: "com.muse.daemon",
      programArguments: [process.execPath, process.argv[1]!, "daemon"],
      stderrPath: join(dir, "daemon.err.log"),
      stdoutPath: join(dir, "daemon.out.log")
    }), "utf8");

    const status = await runDaemon(["--status"], {
      env: {
        ...tmpEnv(),
        MUSE_DAEMON_DELIVERY_ENABLED: "false",
        MUSE_DAEMON_PLIST_FILE: plistFile,
        MUSE_DAEMON_PROVIDER_LOCK: "log",
        MUSE_SELFLEARN_ENABLED: "false"
      },
      platform: "darwin",
      registry: new MessagingProviderRegistry([capturingProvider([], "log")]),
      runLaunchctl: async () => ({ code: 0, stderr: "", stdout: '{\n\t"PID" = 732;\n};\n' })
    });

    expect(status.stdout).toContain("safety=resident LaunchAgent");
    expect(status.stdout).toContain("delivery:   enabled");
    expect(status.stdout).toContain("route-lock: disabled");
    expect(status.stdout).not.toContain("self-learn: disabled (safety gate)");
  });

  it("--status reads the resident heavy-work cap and treats its absence as unbounded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-status-heavy-work-cap-"));
    const plistFile = join(dir, "com.muse.daemon.plist");
    const makePlist = (environmentVariables?: Record<string, string>) => buildLaunchAgentPlist({
      ...(environmentVariables ? { environmentVariables } : {}),
      label: "com.muse.daemon",
      programArguments: [process.execPath, process.argv[1]!, "daemon"],
      stderrPath: join(dir, "daemon.err.log"),
      stdoutPath: join(dir, "daemon.out.log")
    });
    const common = {
      env: { ...tmpEnv(), MUSE_DAEMON_HEAVY_WORK_UNITS_PER_TICK: "1", MUSE_DAEMON_PLIST_FILE: plistFile },
      platform: "darwin" as const,
      registry: new MessagingProviderRegistry([capturingProvider([], "log")]),
      runLaunchctl: async () => ({ code: 0, stderr: "", stdout: '{\n\t"PID" = 733;\n};\n' })
    };

    writeFileSync(plistFile, makePlist({ MUSE_DAEMON_HEAVY_WORK_UNITS_PER_TICK: "2" }), "utf8");
    const resident = await runDaemon(["--status"], common);
    expect(resident.stdout).toContain("2 unit(s) per admitted tick");
    expect(resident.stdout).not.toContain("1 unit(s) per admitted tick");

    writeFileSync(plistFile, makePlist(), "utf8");
    const absent = await runDaemon(["--status"], common);
    expect(absent.stdout).toContain("unbounded");
  });

  it("--status reports a launchctl probe failure as unknown instead of pretending the job is absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-autostart-probe-fail-"));
    const plistFile = join(dir, "com.muse.daemon.plist");
    writeFileSync(plistFile, buildLaunchAgentPlist({
      label: "com.muse.daemon",
      programArguments: [process.execPath, process.argv[1]!, "daemon"],
      stderrPath: join(dir, "daemon.err.log"),
      stdoutPath: join(dir, "daemon.out.log")
    }), "utf8");

    const status = await runDaemon(["--status", "--provider", "telegram"], {
      env: { ...tmpEnv(), MUSE_DAEMON_PLIST_FILE: plistFile },
      platform: "darwin",
      registry: new MessagingProviderRegistry([capturingProvider([])]),
      runLaunchctl: async () => ({ code: 5, stderr: "Operation not permitted", stdout: "" })
    });

    expect(status.stdout).toContain("runtime:      unknown (launchctl list failed (exit 5): Operation not permitted)");
    expect(status.stdout).not.toContain("runtime:      not registered");
  });

  it("--status preserves a running orphan while warning that its LaunchAgent artifact is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-autostart-orphan-"));
    const plistFile = join(dir, "missing.plist");
    const registry = new MessagingProviderRegistry([capturingProvider([])]);

    const status = await runDaemon(["--status", "--provider", "telegram"], {
      env: { ...tmpEnv(), MUSE_DAEMON_PLIST_FILE: plistFile },
      platform: "darwin",
      registry,
      runLaunchctl: async () => ({
        code: 0,
        stderr: "",
        stdout: '{\n\t"PID" = 731;\n\t"LastExitStatus" = 0;\n};\n'
      })
    });

    expect(status.stdout).toContain("autostart:    not ready");
    expect(status.stdout).toContain("artifact:     missing");
    expect(status.stdout).toContain("runtime:      running (pid 731)");
  });

  it("--status distinguishes healthy, registered-not-running, and crash-looping launchd jobs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-autostart-runtime-"));
    const plistFile = join(dir, "com.muse.daemon.plist");
    const registry = new MessagingProviderRegistry([capturingProvider([])]);
    writeFileSync(plistFile, buildLaunchAgentPlist({
      label: "com.muse.daemon",
      programArguments: [process.execPath, process.argv[1]!, "daemon"],
      stderrPath: join(dir, "daemon.err.log"),
      stdoutPath: join(dir, "daemon.out.log")
    }), "utf8");
    const env = { ...tmpEnv(), MUSE_DAEMON_PLIST_FILE: plistFile };

    const healthy = await runDaemon(["--status", "--provider", "telegram"], {
      env, platform: "darwin", registry,
      runLaunchctl: async () => ({ code: 0, stderr: "", stdout: '{\n\t"PID" = 42;\n\t"LastExitStatus" = 0;\n};\n' })
    });
    expect(healthy.stdout).toContain("autostart:    healthy");
    expect(healthy.stdout).toContain("runtime:      running (pid 42)");

    const stopped = await runDaemon(["--status", "--provider", "telegram"], {
      env, platform: "darwin", registry,
      runLaunchctl: async () => ({ code: 0, stderr: "", stdout: '{\n\t"LastExitStatus" = 0;\n};\n' })
    });
    expect(stopped.stdout).toContain("runtime:      registered but not running");

    const crashLoop = await runDaemon(["--status", "--provider", "telegram"], {
      env, platform: "darwin", registry,
      runLaunchctl: async () => ({ code: 0, stderr: "", stdout: '{\n\t"LastExitStatus" = 78;\n};\n' })
    });
    expect(crashLoop.stdout).toContain("runtime:      crash-looping (last exit status 78)");
    expect(crashLoop.stdout).toContain("autostart:    not ready");
  });

  it("--status keeps a running job degraded when its persisted CLI entrypoint is stale", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-autostart-stale-"));
    const plistFile = join(dir, "com.muse.daemon.plist");
    const missingEntry = join(dir, "gone", "dbg.mjs");
    const registry = new MessagingProviderRegistry([capturingProvider([])]);
    writeFileSync(plistFile, buildLaunchAgentPlist({
      label: "com.muse.daemon",
      programArguments: [process.execPath, missingEntry, "daemon"],
      stderrPath: join(dir, "daemon.err.log"),
      stdoutPath: join(dir, "daemon.out.log")
    }), "utf8");

    const status = await runDaemon(["--status", "--provider", "telegram"], {
      env: { ...tmpEnv(), MUSE_DAEMON_PLIST_FILE: plistFile },
      platform: "darwin",
      registry,
      runLaunchctl: async () => ({ code: 0, stderr: "", stdout: '{\n\t"PID" = 77;\n};\n' })
    });

    expect(status.stdout).toContain("artifact:     stale entrypoint");
    expect(status.stdout).toContain(missingEntry);
    expect(status.stdout).toContain("runtime:      running (pid 77)");
    expect(status.stdout).toContain("autostart:    not ready");
  });

  it("--status reports the resolved source paths (debuggability)", async () => {
    const env = tmpEnv();
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);

    const res = await runDaemon(["--status", "--provider", "telegram", "--destination", "555"], { env, registry });

    expect(res.stdout).toContain("sources:");
    expect(res.stdout).toContain(env.MUSE_TASKS_FILE!);
    expect(res.stdout).toContain(env.MUSE_REMINDERS_FILE!);
    expect(res.stdout).toContain(env.MUSE_OBJECTIVES_FILE!);
    expect(sent).toHaveLength(0);
  });

  it("--status reports each tick enabled when its config is present", async () => {
    const env: NodeJS.ProcessEnv = { ...tmpEnv(),
      MUSE_AMBIENT_RULES: JSON.stringify([{ id: "r", title: "t", message: "m", match: { app: "X" } }]),
      MUSE_WEB_WATCH_CONFIG: JSON.stringify([{ id: "w", url: "https://x.example", title: "t", message: "m", rule: { appears: "Y" } }])
    };
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);

    const res = await runDaemon(
      ["--status", "--provider", "telegram", "--destination", "555"],
      { env, registry, resolveFollowupModel: async () => fakeFollowupModel() }
    );

    expect(res.stdout).toContain("followup:   enabled");
    expect(res.stdout).toContain("ambient:    enabled");
    expect(res.stdout).toContain("web-watch:  enabled");
    expect(res.stdout).toContain("objectives: enabled");
    expect(sent).toHaveLength(0);
  });

  it("--init persists provider+destination so a later run reads them from the config file (no flag/env)", async () => {
    const env = tmpEnv();
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);

    const init = await runDaemon(["--init", "--provider", "telegram", "--destination", "555"], { env, registry });
    expect(init.exitCode).toBeUndefined();
    expect(init.stdout).toContain("config written");
    expect(init.stdout).toMatch(/provider=telegram, destination=555/);

    // Second run carries NO --provider/--destination and the env has no
    // MUSE_PROACTIVE_* — provider/destination must come from the config file.
    const dueSoon = new Date(Date.now() + 5 * 60_000).toISOString();
    writeFileSync(env.MUSE_TASKS_FILE!, JSON.stringify({
      tasks: [{ id: "t1", title: "Config-routed memo", status: "open", dueAt: dueSoon, createdAt: "2026-01-01T00:00:00Z" }]
    }), "utf8");

    const res = await runDaemon(["--once"], { env, registry });
    expect(res.exitCode).toBeUndefined();
    expect(res.stdout).toMatch(/provider=telegram, destination=555/);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.destination).toBe("555");
  });

  it("pauses and resumes heavyweight work through config without constructing a registry or model", async () => {
    const env: NodeJS.ProcessEnv = { ...tmpEnv(), MUSE_DAEMON_DELIVERY_ENABLED: "false" };
    writeFileSync(env.MUSE_DAEMON_CONFIG_FILE!, JSON.stringify({
      dailyBrief: { enabled: true, time: "09:00" },
      destination: "555",
      provider: "telegram"
    }), "utf8");
    const registry = new MessagingProviderRegistry([capturingProvider([])]);
    const buildMessagingRegistry = vi.fn((): never => { throw new Error("pause must not construct messaging"); });
    const resolveFollowupModel = vi.fn(async (): Promise<undefined> => {
      throw new Error("pause must not resolve a model");
    });

    const paused = await runDaemon(["--pause-heavy-work"], {
      buildMessagingRegistry,
      env,
      registry,
      resolveFollowupModel
    });
    expect(paused.exitCode).toBeUndefined();
    expect(paused.stdout).toContain("heavyweight work paused; all other work remains subject");
    expect(JSON.parse(readFileSync(env.MUSE_DAEMON_CONFIG_FILE!, "utf8"))).toEqual({
      dailyBrief: { enabled: true, time: "09:00" },
      destination: "555",
      heavyWorkPaused: true,
      provider: "telegram"
    });
    expect(buildMessagingRegistry).not.toHaveBeenCalled();
    expect(resolveFollowupModel).not.toHaveBeenCalled();

    const status = await runDaemon(["--status", "--provider", "telegram", "--destination", "555"], {
      env,
      registry
    });
    expect(status.stdout).toContain("heavy-work: paused by owner");

    const resumed = await runDaemon(["--resume-heavy-work"], {
      buildMessagingRegistry,
      env,
      registry,
      resolveFollowupModel
    });
    expect(resumed.exitCode).toBeUndefined();
    expect(resumed.stdout).toContain("will resume on the next admitted tick");
    expect(JSON.parse(readFileSync(env.MUSE_DAEMON_CONFIG_FILE!, "utf8"))).toEqual({
      dailyBrief: { enabled: true, time: "09:00" },
      destination: "555",
      provider: "telegram"
    });
  });

  it("--once full daemon: all five ticks deliver end-to-end in one run", async () => {
    const env: NodeJS.ProcessEnv = { ...tmpEnv(),
      MUSE_AMBIENT_RULES: JSON.stringify([{ id: "r", title: "Heads up", message: "You're in Slack", match: { app: "Slack" } }]),
      MUSE_WEB_WATCH_CONFIG: JSON.stringify([{ id: "w", url: "https://x.example", title: "Stock", message: "the item is sold out", rule: { appears: "SOLD OUT" } }])
    };
    const dueSoon = new Date(Date.now() + 5 * 60_000).toISOString();
    writeFileSync(env.MUSE_TASKS_FILE!, JSON.stringify({
      tasks: [{ id: "t1", title: "Ship the memo", status: "open", dueAt: dueSoon, createdAt: "2026-01-01T00:00:00Z" }]
    }), "utf8");
    writeFileSync(env.MUSE_AMBIENT_FILE!, JSON.stringify({ app: "Slack", window: "general" }), "utf8");
    await writeFollowups(env.MUSE_FOLLOWUPS_FILE!, [
      { createdAt: "2026-01-01T00:00:00Z", id: "fu1", scheduledFor: "2026-01-02T00:00:00Z", status: "scheduled", summary: "Check the memo", userId: "stark" }
    ]);
    await writeObjectives(env.MUSE_OBJECTIVES_FILE!, [
      { attempts: 0, createdAt: "2026-01-01T00:00:00Z", id: "obj1", kind: "watch", spec: "ping when the build goes green", status: "active", userId: "stark" }
    ]);
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);
    // One model serves both followup synthesis (prose) and the objectives
    // evidence proposal (JSON) — branch on the evaluator prompt's "store"
    // token. The proposed tasks query matches the "Ship the memo" fixture
    // already seeded above for the proactive tick.
    const smartModel: DaemonHelpers["resolveFollowupModel"] = async () => ({
      model: "test-model",
      modelProvider: { generate: async (req: { messages?: unknown }) => {
        const blob = JSON.stringify(req.messages ?? "");
        return blob.includes("windowDays")
          ? { output: '{"store":"tasks","keywords":["memo"]}' }
          : { output: "Quick follow-up on the memo." };
      } } as never
    });
    const fetchImpl = (async () => new Response("Status: SOLD OUT", { status: 200 })) as unknown as typeof globalThis.fetch;

    const res = await runDaemon(
      ["--once", "--provider", "telegram", "--destination", "555"],
      { env, fetchImpl, registry, resolveFollowupModel: smartModel }
    );

    expect(res.exitCode).toBeUndefined();
    expect(res.stdout).toMatch(/proactive: fired 1\/1/);
    expect(res.stdout).toMatch(/followup: fired 1\/1/);
    expect(res.stdout).toMatch(/ambient: delivered 1/);
    expect(res.stdout).toMatch(/web-watch: delivered 1/);
    expect(res.stdout).toMatch(/objectives: 1 fired/);
    expect(sent).toHaveLength(5);
  });

  it("--once: a denied/timed-out send produces NO delivery and the daemon stays up (outbound-safety)", async () => {
    const env = tmpEnv();
    const dueSoon = new Date(Date.now() + 5 * 60_000).toISOString();
    writeFileSync(env.MUSE_TASKS_FILE!, JSON.stringify({
      tasks: [{ id: "t1", title: "Memo", status: "open", dueAt: dueSoon, createdAt: "2026-01-01T00:00:00Z" }]
    }), "utf8");
    const sent: OutboundMessage[] = [];
    const denyingProvider: MessagingProvider = {
      describe: () => ({ description: "t", displayName: "T", id: "telegram" }),
      id: "telegram",
      async send(): Promise<OutboundReceipt> { throw new Error("send timed out"); }
    };
    const registry = new MessagingProviderRegistry([denyingProvider]);

    const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], { env, registry });

    expect(res.exitCode).toBeUndefined();
    expect(res.stdout).toMatch(/proactive: fired 0\/1 imminent, 1 error/);
    expect(sent).toHaveLength(0);
  });

  it("--install UNLOADS any stale definition BEFORE (re)loading, then LOADS via launchctl, passing the exact argv", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-install-"));
    const plistFile = join(dir, "com.muse.daemon.plist");
    const env: NodeJS.ProcessEnv = {
      ...tmpEnv(),
      MUSE_AUTO_REINDEX_EMBED_TIMEOUT_MS: "5000",
      MUSE_AUTO_REINDEX_MAX_EMBEDDINGS: "1",
      MUSE_BACKGROUND_MODEL_MAX_CONCURRENCY: "1",
      MUSE_BACKGROUND_MODEL_MAX_INPUT_BYTES: "65536",
      MUSE_BACKGROUND_MODEL_MAX_OUTPUT_TOKENS: "512",
      MUSE_BACKGROUND_MODEL_MAX_QUEUE: "2",
      MUSE_DAEMON_PLIST_FILE: plistFile,
      MUSE_DAEMON_DELIVERY_ENABLED: "false",
      MUSE_DAEMON_HEAVY_WORK_UNITS_PER_TICK: "2",
      MUSE_DAEMON_BACKGROUND_MODE: "paused",
      MUSE_DAEMON_MAX_LOAD_PER_CORE: "0.5",
      MUSE_DAEMON_MIN_IDLE_SECONDS: "600",
      MUSE_DAEMON_MIN_FREE_MEMORY_MB: "2048",
      MUSE_DAEMON_PROVIDER_LOCK: "log",
      MUSE_DAEMON_RESOURCE_GUARD: "true",
      MUSE_LOCAL_ONLY: "true",
      MUSE_PROACTIVE_PROVIDER: "telegram",
      MUSE_SELFLEARN_ENABLED: "false",
      OPENAI_API_KEY: "must-not-enter-plist"
    };
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);
    const calls: (readonly string[])[] = [];
    const runLaunchctl = async (args: readonly string[]) => {
      calls.push(args);
      if (args[0] === "unload") return { code: 1, stderr: "Could not find specified service", stdout: "" }; // nothing loaded yet — fine
      if (args[0] === "load") return { code: 0, stderr: "", stdout: "" };
      // `list <label>` — launchd's real dump format, not tab-separated.
      return { code: 0, stderr: "", stdout: '{\n\t"PID" = 555;\n\t"LastExitStatus" = 0;\n\t"Label" = "com.muse.daemon";\n};\n' };
    };

    const res = await runDaemon(["--install", "--provider", "telegram", "--destination", "555"], { env, platform: "darwin", registry, runLaunchctl });

    expect(res.exitCode).toBeUndefined();
    expect(res.stdout).toContain("LaunchAgent written");
    expect(res.stdout).toContain("loaded via launchctl and RUNNING (pid 555");
    expect(existsSync(plistFile)).toBe(true);
    expect(sent).toHaveLength(0);
    const plist = readFileSync(plistFile, "utf8");
    expect(plist).toContain("<key>EnvironmentVariables</key>");
    expect(plist).toContain("<key>MUSE_LOCAL_ONLY</key>\n    <string>true</string>");
    expect(plist).toContain("<key>MUSE_SELFLEARN_ENABLED</key>\n    <string>false</string>");
    expect(plist).toContain("<key>MUSE_DAEMON_DELIVERY_ENABLED</key>\n    <string>false</string>");
    expect(plist).toContain("<key>MUSE_DAEMON_PROVIDER_LOCK</key>\n    <string>log</string>");
    expect(plist).toContain("<key>MUSE_DAEMON_RESOURCE_GUARD</key>\n    <string>true</string>");
    expect(plist).toContain("<key>MUSE_DAEMON_BACKGROUND_MODE</key>\n    <string>paused</string>");
    expect(plist).toContain("<key>MUSE_DAEMON_MIN_IDLE_SECONDS</key>\n    <string>600</string>");
    expect(plist).toContain("<key>MUSE_DAEMON_MIN_FREE_MEMORY_MB</key>\n    <string>2048</string>");
    expect(plist).toContain("<key>MUSE_DAEMON_MAX_LOAD_PER_CORE</key>\n    <string>0.5</string>");
    expect(plist).toContain("<key>MUSE_DAEMON_HEAVY_WORK_UNITS_PER_TICK</key>\n    <string>2</string>");
    expect(plist).toContain("<key>MUSE_BACKGROUND_MODEL_MAX_CONCURRENCY</key>\n    <string>1</string>");
    expect(plist).toContain("<key>MUSE_BACKGROUND_MODEL_MAX_QUEUE</key>\n    <string>2</string>");
    expect(plist).toContain("<key>MUSE_BACKGROUND_MODEL_MAX_INPUT_BYTES</key>\n    <string>65536</string>");
    expect(plist).toContain("<key>MUSE_BACKGROUND_MODEL_MAX_OUTPUT_TOKENS</key>\n    <string>512</string>");
    expect(plist).toContain("<key>MUSE_AUTO_REINDEX_MAX_EMBEDDINGS</key>\n    <string>1</string>");
    expect(plist).toContain("<key>MUSE_AUTO_REINDEX_EMBED_TIMEOUT_MS</key>\n    <string>5000</string>");
    expect(plist).not.toContain("MUSE_PROACTIVE_PROVIDER");
    expect(plist).not.toContain("must-not-enter-plist");
    // The exact argv passed to the seam, IN ORDER — unload adopts the fresh
    // plist before load, never a shell string, never a guess.
    expect(calls[0]).toEqual(["unload", "-w", plistFile]);
    expect(calls[1]).toEqual(["load", "-w", plistFile]);
    expect(calls[2]).toEqual(["list", "com.muse.daemon"]);
    if (process.platform === "darwin") {
      expect(() => execFileSync("plutil", ["-lint", plistFile], { encoding: "utf8" })).not.toThrow();
    }
  });

  it("--install --safe persists a contained activation profile without changing ambient owner input", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-install-safe-"));
    const plistFile = join(dir, "com.muse.daemon.plist");
    const env: NodeJS.ProcessEnv = {
      ...tmpEnv(),
      MUSE_DAEMON_DELIVERY_ENABLED: "true",
      MUSE_DAEMON_PLIST_FILE: plistFile,
      MUSE_DAEMON_PROVIDER_LOCK: "",
      MUSE_LOCAL_ONLY: "false",
      MUSE_SELFLEARN_ENABLED: "true"
    };
    const result = await runDaemon(["--install", "--safe"], {
      env,
      platform: "darwin",
      registry: new MessagingProviderRegistry([capturingProvider([])]),
      runLaunchctl: async (args) => args[0] === "list"
        ? { code: 0, stderr: "", stdout: '{\n\t"PID" = 777;\n};\n' }
        : { code: 0, stderr: "", stdout: "" }
    });

    const plist = readFileSync(plistFile, "utf8");
    expect(result.exitCode).toBeUndefined();
    expect(plist).toContain("<key>MUSE_LOCAL_ONLY</key>\n    <string>true</string>");
    expect(plist).toContain("<key>MUSE_DAEMON_PROVIDER_LOCK</key>\n    <string>log</string>");
    expect(plist).toContain("<key>MUSE_DAEMON_DELIVERY_ENABLED</key>\n    <string>false</string>");
    expect(plist).toContain("<key>MUSE_SELFLEARN_ENABLED</key>\n    <string>false</string>");
    expect(env.MUSE_LOCAL_ONLY).toBe("false");
    expect(env.MUSE_DAEMON_DELIVERY_ENABLED).toBe("true");
    expect(env.MUSE_SELFLEARN_ENABLED).toBe("true");
  });

  it("rejects --safe without --install", async () => {
    const result = await runDaemon(["--safe"], {
      env: tmpEnv(),
      registry: new MessagingProviderRegistry([capturingProvider([])])
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("only valid with --install");
  });

  it("--install rejects a temporary CLI entry before writing a plist or invoking launchctl", async () => {
    const cliTempRoot = mkdtempSync(join(tmpdir(), "muse-install-temp-entry-"));
    const cliEntry = join(cliTempRoot, "dbg.mjs");
    writeFileSync(cliEntry, "export {};\n", "utf8");
    const targetDir = mkdtempSync(join(tmpdir(), "muse-install-temp-target-"));
    const plistFile = join(targetDir, "com.muse.daemon.plist");
    const calls: (readonly string[])[] = [];

    const res = await runDaemon(["--install"], {
      daemonCliEntry: cliEntry,
      daemonTemporaryRoots: [cliTempRoot],
      env: { ...tmpEnv(), MUSE_DAEMON_PLIST_FILE: plistFile },
      platform: "darwin",
      registry: new MessagingProviderRegistry([capturingProvider([])]),
      runLaunchctl: async (args) => {
        calls.push(args);
        return { code: 0, stderr: "", stdout: "" };
      }
    });

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("inside a temporary directory");
    expect(res.stderr).toContain("stable installed Muse CLI");
    expect(calls).toHaveLength(0);
    expect(existsSync(plistFile)).toBe(false);
  });

  it("--install rejects an unsupported provider lock before writing or loading autostart state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-install-invalid-lock-"));
    const plistFile = join(dir, "com.muse.daemon.plist");
    const calls: (readonly string[])[] = [];
    const result = await runDaemon(["--install"], {
      env: { ...tmpEnv(), MUSE_DAEMON_PLIST_FILE: plistFile, MUSE_DAEMON_PROVIDER_LOCK: "telegram" },
      platform: "darwin",
      registry: new MessagingProviderRegistry([capturingProvider([])]),
      runLaunchctl: async (args) => {
        calls.push(args);
        return { code: 0, stderr: "", stdout: "" };
      }
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("must be unset or 'log'");
    expect(result.stderr).not.toContain("telegram");
    expect(calls).toHaveLength(0);
    expect(existsSync(plistFile)).toBe(false);
  });

  it("--install reports FAILURE (never success) when launchctl returns non-zero and the agent isn't actually registered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-install-fail-"));
    const plistFile = join(dir, "com.muse.daemon.plist");
    const env: NodeJS.ProcessEnv = { ...tmpEnv(), MUSE_DAEMON_PLIST_FILE: plistFile };
    const registry = new MessagingProviderRegistry([capturingProvider([])]);
    const runLaunchctl = async (args: readonly string[]) =>
      args[0] === "load"
        ? { code: 5, stderr: "Load failed: 5: Input/output error", stdout: "" }
        : { code: 1, stderr: "", stdout: "" }; // `unload`/`list` both confirm nothing is registered

    const res = await runDaemon(["--install"], { env, platform: "darwin", registry, runLaunchctl });

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("launchctl load failed");
    expect(res.stdout).not.toContain("loaded via launchctl");
    // The plist is still written (harmless), but never claimed as running.
    expect(existsSync(plistFile)).toBe(true);
  });

  it("--install reports FAILURE (not success) when launchctl registers the label but it is CRASH-LOOPING (no pid, non-zero LastExitStatus)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-install-crashloop-"));
    const plistFile = join(dir, "com.muse.daemon.plist");
    const env: NodeJS.ProcessEnv = { ...tmpEnv(), MUSE_DAEMON_PLIST_FILE: plistFile };
    const registry = new MessagingProviderRegistry([capturingProvider([])]);
    const runLaunchctl = async (args: readonly string[]) => {
      if (args[0] === "unload") return { code: 1, stderr: "Could not find specified service", stdout: "" };
      if (args[0] === "load") return { code: 0, stderr: "", stdout: "" };
      // `list` — registered (exit 0) but no PID and a non-zero LastExitStatus:
      // the job crashed/failed to start, and a code-only check can't see it.
      return { code: 0, stderr: "", stdout: '{\n\t"LastExitStatus" = 78;\n\t"Label" = "com.muse.daemon";\n};\n' };
    };

    const res = await runDaemon(["--install"], { env, platform: "darwin", registry, runLaunchctl });

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("crash-looping");
    expect(res.stderr).toContain("last exit status 78");
    expect(res.stdout).not.toContain("RUNNING");
  });

  it("--install re-adopts an already-loaded label after unload+load, verified running via the pid in `list`", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-install-idem-"));
    const plistFile = join(dir, "com.muse.daemon.plist");
    const env: NodeJS.ProcessEnv = { ...tmpEnv(), MUSE_DAEMON_PLIST_FILE: plistFile };
    const registry = new MessagingProviderRegistry([capturingProvider([])]);
    const runLaunchctl = async (args: readonly string[]) => {
      if (args[0] === "unload") return { code: 0, stderr: "", stdout: "" }; // the STALE definition unloads cleanly
      if (args[0] === "load") return { code: 3, stderr: "Service already loaded", stdout: "" }; // some launchd versions still report this
      return { code: 0, stderr: "", stdout: '{\n\t"PID" = 4242;\n\t"LastExitStatus" = 0;\n};\n' }; // `list` confirms it's actually running
    };

    const res = await runDaemon(["--install"], { env, platform: "darwin", registry, runLaunchctl });

    expect(res.exitCode).toBeUndefined();
    expect(res.stdout).toContain("loaded via launchctl and RUNNING (pid 4242");
    expect(res.stderr).toBe("");
  });

  it("--uninstall unloads, VERIFIES via list that the label is gone, then removes the plist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-uninstall-"));
    const plistFile = join(dir, "com.muse.daemon.plist");
    writeFileSync(plistFile, "<plist/>", "utf8");
    const env: NodeJS.ProcessEnv = { ...tmpEnv(), MUSE_DAEMON_PLIST_FILE: plistFile };
    const registry = new MessagingProviderRegistry([capturingProvider([])]);
    const calls: (readonly string[])[] = [];
    const runLaunchctl = async (args: readonly string[]) => {
      calls.push(args);
      if (args[0] === "list") return { code: 1, stderr: "Could not find specified service", stdout: "" }; // confirms GONE
      return { code: 0, stderr: "", stdout: "" };
    };

    const res = await runDaemon(["--uninstall"], { env, platform: "darwin", registry, runLaunchctl });

    expect(res.exitCode).toBeUndefined();
    expect(res.stdout).toContain("unloaded and removed");
    expect(calls[0]).toEqual(["unload", "-w", plistFile]);
    expect(calls[1]).toEqual(["list", "com.muse.daemon"]);
    expect(existsSync(plistFile)).toBe(false);
  });

  it("--uninstall KEEPS the plist and fails when `list` shows the job is STILL registered/running after unload (no orphan daemon)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-uninstall-stuck-"));
    const plistFile = join(dir, "com.muse.daemon.plist");
    writeFileSync(plistFile, "<plist/>", "utf8");
    const env: NodeJS.ProcessEnv = { ...tmpEnv(), MUSE_DAEMON_PLIST_FILE: plistFile };
    const registry = new MessagingProviderRegistry([capturingProvider([])]);
    const runLaunchctl = async (args: readonly string[]) => {
      if (args[0] === "unload") return { code: 5, stderr: "Operation not permitted", stdout: "" };
      // `list` still finds it — unload did NOT actually take effect.
      return { code: 0, stderr: "", stdout: '{\n\t"PID" = 999;\n\t"LastExitStatus" = 0;\n};\n' };
    };

    const res = await runDaemon(["--uninstall"], { env, platform: "darwin", registry, runLaunchctl });

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("still registered");
    expect(res.stderr).toContain("pid 999");
    // The plist is KEPT — a second --uninstall still has a route back,
    // instead of an orphaned KeepAlive daemon with nothing left to remove.
    expect(existsSync(plistFile)).toBe(true);
  });

  it("--uninstall on a machine with no plist is a clean no-op, not a crash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-uninstall-none-"));
    const plistFile = join(dir, "com.muse.daemon.plist");
    const env: NodeJS.ProcessEnv = { ...tmpEnv(), MUSE_DAEMON_PLIST_FILE: plistFile };
    const registry = new MessagingProviderRegistry([capturingProvider([])]);
    const calls: (readonly string[])[] = [];
    const runLaunchctl = async (args: readonly string[]) => {
      calls.push(args);
      return { code: 0, stderr: "", stdout: "" };
    };

    const res = await runDaemon(["--uninstall"], { env, platform: "darwin", registry, runLaunchctl });

    expect(res.exitCode).toBeUndefined();
    expect(res.stdout).toContain("was not installed");
    expect(calls).toHaveLength(0); // never shells out to unload something that isn't there
    expect(existsSync(plistFile)).toBe(false);
  });

  it("--install on win32 registers a schtasks ONLOGON task and writes NO plist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-install-win-"));
    const plistFile = join(dir, "com.muse.daemon.plist");
    const env: NodeJS.ProcessEnv = { ...tmpEnv(), MUSE_DAEMON_PLIST_FILE: plistFile };
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);
    const calls: (readonly string[])[] = [];
    const schtasksRun = async (args: readonly string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
      calls.push(args);
      return { exitCode: 0, stderr: "", stdout: "SUCCESS" };
    };

    const res = await runDaemon(["--install"], { env, platform: "win32", registry, schtasksRun });

    expect(res.exitCode).toBeUndefined();
    expect(res.stdout).toContain("registered as scheduled task 'MuseDaemon'");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 6)).toEqual(["/Create", "/F", "/SC", "ONLOGON", "/TN", "MuseDaemon"]);
    expect(calls[0]![6]).toBe("/TR");
    expect(calls[0]![7]).toContain("daemon");
    expect(existsSync(plistFile)).toBe(false);
  });

  it("--install on win32 with a failing schtasks exits 1 and writes NOTHING", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-install-win-fail-"));
    const plistFile = join(dir, "com.muse.daemon.plist");
    const env: NodeJS.ProcessEnv = { ...tmpEnv(), MUSE_DAEMON_PLIST_FILE: plistFile };
    const registry = new MessagingProviderRegistry([capturingProvider([])]);
    const schtasksRun = async (): Promise<{ exitCode: number; stdout: string; stderr: string }> =>
      ({ exitCode: 1, stderr: "ERROR: Access is denied.", stdout: "" });

    const res = await runDaemon(["--install"], { env, platform: "win32", registry, schtasksRun });

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("Access is denied");
    expect(existsSync(plistFile)).toBe(false);
  });

  it("--install on linux fails closed — writes NO plist and never touches launchctl (unsupported platform, gated before any I/O)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-install-linux-"));
    const plistFile = join(dir, "com.muse.daemon.plist");
    const env: NodeJS.ProcessEnv = { ...tmpEnv(), MUSE_DAEMON_PLIST_FILE: plistFile };
    const registry = new MessagingProviderRegistry([capturingProvider([])]);
    const calls: (readonly string[])[] = [];
    const runLaunchctl = async (args: readonly string[]) => { calls.push(args); return { code: 0, stderr: "", stdout: "" }; };

    const res = await runDaemon(["--install"], { env, platform: "linux", registry, runLaunchctl });

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("only wired for macOS");
    expect(existsSync(plistFile)).toBe(false); // no macOS plist litter on a Linux box
    expect(calls).toHaveLength(0); // never execs a nonexistent launchctl
  });

  it("--uninstall on linux fails closed instead of attempting a macOS-only unload", async () => {
    const env = tmpEnv();
    const registry = new MessagingProviderRegistry([capturingProvider([])]);
    const calls: (readonly string[])[] = [];
    const runLaunchctl = async (args: readonly string[]) => { calls.push(args); return { code: 0, stderr: "", stdout: "" }; };

    const res = await runDaemon(["--uninstall"], { env, platform: "linux", registry, runLaunchctl });

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("only wired for macOS");
    expect(calls).toHaveLength(0);
  });

  it("--status on win32 reports schtasks autostart state from the query", async () => {
    const env: NodeJS.ProcessEnv = tmpEnv();
    const registry = new MessagingProviderRegistry([capturingProvider([])]);
    const installed = await runDaemon(["--status", "--provider", "telegram"], {
      env, platform: "win32", registry,
      schtasksRun: async () => ({ exitCode: 0, stderr: "", stdout: "MuseDaemon" })
    });
    expect(installed.stdout).toMatch(/autostart:\s+registered \(scheduled task MuseDaemon\)/);
    expect(installed.stdout).toContain("runtime:      unknown");

    const missing = await runDaemon(["--status", "--provider", "telegram"], {
      env, platform: "win32", registry,
      schtasksRun: async () => ({ exitCode: 1, stderr: "ERROR: The system cannot find the file specified.", stdout: "" })
    });
    expect(missing.stdout).toMatch(/autostart:\s+not registered/);
    expect(missing.stdout).toContain("runtime:      unknown");
  });

  it("--status on an unmanaged platform reports runtime unknown without probing a service manager", async () => {
    const registry = new MessagingProviderRegistry([capturingProvider([])]);
    const launchctlCalls: (readonly string[])[] = [];
    const schtasksCalls: (readonly string[])[] = [];
    const status = await runDaemon(["--status", "--provider", "telegram"], {
      env: tmpEnv(),
      platform: "linux",
      registry,
      runLaunchctl: async (args) => {
        launchctlCalls.push(args);
        return { code: 0, stderr: "", stdout: "" };
      },
      schtasksRun: async (args) => {
        schtasksCalls.push(args);
        return { exitCode: 0, stderr: "", stdout: "" };
      }
    });

    expect(status.stdout).toContain("autostart:    unmanaged on linux");
    expect(status.stdout).toContain("runtime:      unknown");
    expect(launchctlCalls).toHaveLength(0);
    expect(schtasksCalls).toHaveLength(0);
  });

  it("--once delivers a situational briefing when MUSE_BRIEFING_ENABLED and something is imminent", async () => {
    const env: NodeJS.ProcessEnv = { ...tmpEnv(), MUSE_BRIEFING_ENABLED: "true" };
    const dueSoon = new Date(Date.now() + 5 * 60_000).toISOString();
    writeFileSync(env.MUSE_TASKS_FILE!, JSON.stringify({
      tasks: [{ id: "t1", title: "Submit the Q3 report", status: "open", dueAt: dueSoon, createdAt: "2026-01-01T00:00:00Z" }]
    }), "utf8");
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);

    const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], { env, registry });

    expect(res.exitCode).toBeUndefined();
    expect(res.stdout).toMatch(/briefing: delivered/);
    // proactive notice + the briefing digest both went out
    expect(sent.length).toBeGreaterThanOrEqual(2);
  });

  it("rebuilds the single briefing factory with the lazily resolved knowledge enricher", async () => {
    const env: NodeJS.ProcessEnv = { ...tmpEnv(), MUSE_BRIEFING_ENABLED: "true" };
    const dueSoon = new Date(Date.now() + 5 * 60_000).toISOString();
    writeFileSync(env.MUSE_TASKS_FILE!, JSON.stringify({
      tasks: [{ createdAt: "2026-01-01T00:00:00Z", dueAt: dueSoon, id: "t-late", status: "open", title: "Submit the continuity report" }]
    }), "utf8");
    const sent: OutboundMessage[] = [];
    const resolver = vi.fn(async () => async () => "late-bound continuity context");

    const result = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], {
      env,
      registry: new MessagingProviderRegistry([capturingProvider(sent)]),
      resolveKnowledgeEnrich: resolver
    });

    expect(result.exitCode).toBeUndefined();
    expect(resolver).toHaveBeenCalledOnce();
    expect(sent.some((message) => message.text.includes("late-bound continuity context"))).toBe(true);
  });

  it("--once briefing names an upcoming birthday from the user's contacts", async () => {
    const env: NodeJS.ProcessEnv = { ...tmpEnv(), MUSE_BRIEFING_ENABLED: "true" };
    const dueSoon = new Date(Date.now() + 5 * 60_000).toISOString();
    writeFileSync(env.MUSE_TASKS_FILE!, JSON.stringify({
      tasks: [{ id: "t1", title: "Ship it", status: "open", dueAt: dueSoon, createdAt: "2026-01-01T00:00:00Z" }]
    }), "utf8");
    // A contact whose birthday is TODAY → the brief's Birthdays line names them.
    const today = new Date();
    const mmdd = `${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    writeFileSync(env.MUSE_CONTACTS_FILE!, JSON.stringify({
      contacts: [{ id: "c1", name: "Zelda", birthday: mmdd }]
    }), "utf8");
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);

    const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], { env, registry });

    expect(res.exitCode).toBeUndefined();
    expect(res.stdout).toMatch(/briefing: delivered/);
    // only the briefing mentions a birthday — the proactive notice is about the task
    expect(sent.some((m) => m.text.includes("Zelda"))).toBe(true);
  });

  it("--once briefing surfaces an imminent calendar event", async () => {
    const env: NodeJS.ProcessEnv = { ...tmpEnv(), MUSE_BRIEFING_ENABLED: "true" };
    writeFileSync(env.MUSE_TASKS_FILE!, JSON.stringify({ tasks: [] }), "utf8");
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);
    // Contract-faithful calendar lister: one event 5 min out (within the lead window).
    const briefingCalendarLister: NonNullable<DaemonHelpers["briefingCalendarLister"]> = async () => [
      { allDay: false, startsAt: new Date(Date.now() + 5 * 60_000), title: "Standup with the team" }
    ];

    const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], { briefingCalendarLister, env, registry });

    expect(res.exitCode).toBeUndefined();
    expect(res.stdout).toMatch(/briefing: delivered/);
    expect(sent.some((m) => m.text.includes("Standup with the team"))).toBe(true);
  });

  it("briefing tick is skipped when MUSE_BRIEFING_ENABLED is unset (hermetic default)", async () => {
    const env = tmpEnv();
    writeFileSync(env.MUSE_TASKS_FILE!, JSON.stringify({ tasks: [] }), "utf8");
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);

    const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], { env, registry });

    expect(res.stdout).toContain("briefing: skipped");
    expect(sent).toHaveLength(0);
  });

  describe("day rhythm (하루 리듬) — briefing auto-routing", () => {
    it("day rhythm on: auto-routes the morning briefing to the single paired channel when provider is still 'log'", async () => {
      const env = tmpEnv();
      const dueSoon = new Date(Date.now() + 5 * 60_000).toISOString();
      writeFileSync(env.MUSE_TASKS_FILE!, JSON.stringify({
        tasks: [{ id: "t1", title: "Day-rhythm memo", status: "open", dueAt: dueSoon, createdAt: "2026-01-01T00:00:00Z" }]
      }), "utf8");
      writeFileSync(env.MUSE_CHANNEL_OWNERS_FILE!, JSON.stringify({ owners: { telegram: "555" }, version: 1 }), "utf8");
      await writeDayRhythmConfig(env.MUSE_CLI_CONFIG_FILE!, { enabled: true, eveningHour: 18, morningHour: new Date().getHours() });
      const sent: OutboundMessage[] = [];
      const registry = new MessagingProviderRegistry([capturingProvider(sent), new LogMessagingProvider()]);

      // NO --provider/--destination flags — the default resolves to "log".
      const res = await runDaemon(["--once"], { env, registry });

      expect(res.exitCode).toBeUndefined();
      expect(res.stdout).toMatch(/briefing: delivered/);
      const briefingSend = sent.find((m) => m.destination === "555");
      expect(briefingSend).toBeDefined();
    });

    it("day rhythm on: no paired channel → an honest skip, never a silent log-sink send", async () => {
      const env = tmpEnv();
      const dueSoon = new Date(Date.now() + 5 * 60_000).toISOString();
      writeFileSync(env.MUSE_TASKS_FILE!, JSON.stringify({
        tasks: [{ id: "t1", title: "Unpaired memo", status: "open", dueAt: dueSoon, createdAt: "2026-01-01T00:00:00Z" }]
      }), "utf8");
      await writeDayRhythmConfig(env.MUSE_CLI_CONFIG_FILE!, { enabled: true, eveningHour: 18, morningHour: new Date().getHours() });
      const sent: OutboundMessage[] = [];
      const registry = new MessagingProviderRegistry([capturingProvider(sent), new LogMessagingProvider()]);

      const res = await runDaemon(["--once"], { env, registry });

      expect(res.exitCode).toBeUndefined();
      expect(res.stdout).toMatch(/briefing: day rhythm on but no channel paired/);
      expect(sent).toHaveLength(0);
    });

    it("day rhythm on: outside the morning window, the briefing is held (not delivered)", async () => {
      const env = tmpEnv();
      const dueSoon = new Date(Date.now() + 5 * 60_000).toISOString();
      writeFileSync(env.MUSE_TASKS_FILE!, JSON.stringify({
        tasks: [{ id: "t1", title: "Held memo", status: "open", dueAt: dueSoon, createdAt: "2026-01-01T00:00:00Z" }]
      }), "utf8");
      writeFileSync(env.MUSE_CHANNEL_OWNERS_FILE!, JSON.stringify({ owners: { telegram: "555" }, version: 1 }), "utf8");
      // Well clear of the current hour's [morningHour, morningHour+2) window either direction.
      const heldMorningHour = (new Date().getHours() + 6) % 24;
      await writeDayRhythmConfig(env.MUSE_CLI_CONFIG_FILE!, { enabled: true, eveningHour: 18, morningHour: heldMorningHour });
      const sent: OutboundMessage[] = [];
      const registry = new MessagingProviderRegistry([capturingProvider(sent), new LogMessagingProvider()]);

      const res = await runDaemon(["--once"], { env, registry });

      expect(res.exitCode).toBeUndefined();
      expect(res.stdout).toMatch(/briefing: held \(day rhythm morning window/);
      expect(sent).toHaveLength(0);
    });

    it("MUSE_BRIEFING_ENABLED stays byte-compatible even when day rhythm is ALSO on (env path wins: no window gate, no channel override)", async () => {
      const env: NodeJS.ProcessEnv = { ...tmpEnv(), MUSE_BRIEFING_ENABLED: "true" };
      const dueSoon = new Date(Date.now() + 5 * 60_000).toISOString();
      writeFileSync(env.MUSE_TASKS_FILE!, JSON.stringify({
        tasks: [{ id: "t1", title: "Env-path memo", status: "open", dueAt: dueSoon, createdAt: "2026-01-01T00:00:00Z" }]
      }), "utf8");
      // dayRhythm ALSO on, with a window that would otherwise HOLD it and no
      // paired channel at all — neither should matter on the env-flag path.
      const heldMorningHour = (new Date().getHours() + 6) % 24;
      await writeDayRhythmConfig(env.MUSE_CLI_CONFIG_FILE!, { enabled: true, eveningHour: 18, morningHour: heldMorningHour });
      const sent: OutboundMessage[] = [];
      const registry = new MessagingProviderRegistry([capturingProvider(sent)]);

      const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], { env, registry });

      expect(res.exitCode).toBeUndefined();
      expect(res.stdout).toMatch(/briefing: delivered/);
      expect(sent.some((m) => m.destination === "555")).toBe(true);
    });
  });

  it("--print echoes every delivered notice to stdout AND still delivers to the channel", async () => {
    const env = tmpEnv();
    const dueSoon = new Date(Date.now() + 5 * 60_000).toISOString();
    writeFileSync(env.MUSE_TASKS_FILE!, JSON.stringify({
      tasks: [{ id: "t1", title: "Echoed memo", status: "open", dueAt: dueSoon, createdAt: "2026-01-01T00:00:00Z" }]
    }), "utf8");
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);

    const res = await runDaemon(["--once", "--print", "--provider", "telegram", "--destination", "555"], { env, registry });

    expect(res.exitCode).toBeUndefined();
    expect(res.stdout).toContain("📨 555:");
    expect(res.stdout).toContain("Echoed memo");
    expect(sent).toHaveLength(1); // the channel still received it
  });

  it("without --print the delivered notice is NOT echoed to stdout (only the tick summary)", async () => {
    const env = tmpEnv();
    const dueSoon = new Date(Date.now() + 5 * 60_000).toISOString();
    writeFileSync(env.MUSE_TASKS_FILE!, JSON.stringify({
      tasks: [{ id: "t1", title: "Quiet memo", status: "open", dueAt: dueSoon, createdAt: "2026-01-01T00:00:00Z" }]
    }), "utf8");
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);

    const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], { env, registry });

    expect(res.stdout).not.toContain("📨");
    expect(sent).toHaveLength(1);
  });

  it("an unknown provider fails closed — exits non-zero and sends nothing", async () => {
    const env = tmpEnv();
    writeFileSync(env.MUSE_TASKS_FILE!, JSON.stringify({ tasks: [] }), "utf8");
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);

    const res = await runDaemon(["--once", "--provider", "nope", "--destination", "555"], { env, registry });

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("is not registered");
    expect(sent).toHaveLength(0);
  });
});

describe("muse daemon — macos-notification env overlay (onboard's config must actually boot)", () => {
  async function runDaemonCapturingEnv(
    args: string[],
    env: NodeJS.ProcessEnv,
    registry: MessagingProviderRegistry
  ): Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number | undefined; readonly capturedEnv: NodeJS.ProcessEnv | undefined }> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = { stderr: (m: string) => stderr.push(m), stdout: (m: string) => stdout.push(m) };
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const prevExit = process.exitCode;
    let exitCode: number | undefined;
    try {
      const program = new Command();
      program.exitOverride();
      registerDaemonCommands(program, io, {
        buildMessagingRegistry: (e: NodeJS.ProcessEnv) => { capturedEnv = e; return registry; },
        env: () => env,
        resolveFollowupModel: async () => undefined
      });
      await program.parseAsync(["node", "muse", "daemon", ...args]);
      exitCode = process.exitCode === undefined ? undefined : Number(process.exitCode);
    } catch (cause) {
      exitCode = (cause as { exitCode?: number }).exitCode ?? 1;
    } finally {
      process.exitCode = prevExit;
    }
    return { capturedEnv, exitCode, stderr: stderr.join(""), stdout: stdout.join("") };
  }

  it("resolved provider macos-notification with the enable flag UNSET overlays it to 'true' before building the registry", async () => {
    const env = tmpEnv();
    writeFileSync(env.MUSE_TASKS_FILE!, JSON.stringify({ tasks: [] }), "utf8");
    const registry = new MessagingProviderRegistry([{
      describe: () => ({ description: "t", displayName: "T", id: "macos-notification" }),
      id: "macos-notification",
      send: async () => ({ destination: "@me", messageId: "m1", providerId: "macos-notification" })
    }]);

    const res = await runDaemonCapturingEnv(
      ["--once", "--provider", "macos-notification", "--destination", "@me"],
      env,
      registry
    );

    expect(res.exitCode).toBeUndefined();
    expect(res.capturedEnv?.MUSE_MESSAGING_MACOS_NOTIFICATION_ENABLED).toBe("true");
  });

  it("an explicit 'false' is NEVER overlaid — no overlay, and the fail-loud unknown-provider path still fires", async () => {
    const env: NodeJS.ProcessEnv = { ...tmpEnv(), MUSE_MESSAGING_MACOS_NOTIFICATION_ENABLED: "false" };
    writeFileSync(env.MUSE_TASKS_FILE!, JSON.stringify({ tasks: [] }), "utf8");
    // A registry that mirrors the REAL builder's opt-out contract: no
    // macos-notification entry when the flag isn't 'true'.
    const registry = new MessagingProviderRegistry([]);

    const res = await runDaemonCapturingEnv(
      ["--once", "--provider", "macos-notification", "--destination", "@me"],
      env,
      registry
    );

    expect(res.capturedEnv?.MUSE_MESSAGING_MACOS_NOTIFICATION_ENABLED).toBe("false");
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("is not registered");
  });

  it("a non-macos-notification provider is never overlaid", async () => {
    const env = tmpEnv();
    writeFileSync(env.MUSE_TASKS_FILE!, JSON.stringify({ tasks: [] }), "utf8");
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);

    const res = await runDaemonCapturingEnv(
      ["--once", "--provider", "telegram", "--destination", "555"],
      env,
      registry
    );

    expect(res.exitCode).toBeUndefined();
    expect(res.capturedEnv?.MUSE_MESSAGING_MACOS_NOTIFICATION_ENABLED).toBeUndefined();
  });
});

describe("muse daemon — daemon-loop heartbeat (R2-1)", () => {
  it("delivery brake --once records only the daemon-loop heartbeat before poisoned initialization seams", async () => {
    const env: NodeJS.ProcessEnv = { ...tmpEnv(), MUSE_DAEMON_DELIVERY_ENABLED: "false" };
    const sidecarDir = dirname(env.MUSE_PROACTIVE_SIDECAR_FILE!);
    const buildMessagingRegistry = vi.fn((): MessagingProviderRegistry => {
      throw new Error("registry must not initialize while delivery is braked");
    });
    const buildCalendarRegistry = vi.fn((): never => {
      throw new Error("calendar must not initialize while delivery is braked");
    });
    const readDaemonConfig = vi.fn((): never => {
      throw new Error("config must not be read while delivery is braked");
    });
    const resolveFollowupModel = vi.fn(async () => {
      throw new Error("model must not initialize while delivery is braked");
    });

    const result = await runDaemon(["--once"], {
      buildMessagingRegistry,
      buildCalendarRegistry,
      env,
      readDaemonConfig,
      registry: new MessagingProviderRegistry(),
      resolveFollowupModel
    });

    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toContain("delivery brake engaged");
    expect(buildMessagingRegistry).not.toHaveBeenCalled();
    expect(buildCalendarRegistry).not.toHaveBeenCalled();
    expect(readDaemonConfig).not.toHaveBeenCalled();
    expect(resolveFollowupModel).not.toHaveBeenCalled();
    expect(readdirSync(sidecarDir).sort()).toEqual(["proactive-heartbeat-daemon-loop.json"]);
  });

  it("delivery brake resident mode gives runDaemonLoop a heartbeat-only tick and restores signal listeners", async () => {
    const env: NodeJS.ProcessEnv = { ...tmpEnv(), MUSE_DAEMON_DELIVERY_ENABLED: "false" };
    const buildMessagingRegistry = vi.fn((): MessagingProviderRegistry => {
      throw new Error("registry must not initialize while delivery is braked");
    });
    const resolveFollowupModel = vi.fn(async () => {
      throw new Error("model must not initialize while delivery is braked");
    });
    const runDaemonLoop = vi.fn<NonNullable<DaemonHelpers["runDaemonLoop"]>>(async ({ tick }) => {
      await tick();
      await tick();
      return 2;
    });
    const sigintBefore = process.listenerCount("SIGINT");
    const sigtermBefore = process.listenerCount("SIGTERM");

    const result = await runDaemon([], {
      buildMessagingRegistry,
      env,
      registry: new MessagingProviderRegistry(),
      resolveFollowupModel,
      runDaemonLoop
    });

    expect(result.exitCode).toBeUndefined();
    expect(runDaemonLoop).toHaveBeenCalledOnce();
    expect(buildMessagingRegistry).not.toHaveBeenCalled();
    expect(resolveFollowupModel).not.toHaveBeenCalled();
    expect(readdirSync(dirname(env.MUSE_PROACTIVE_SIDECAR_FILE!)).sort()).toEqual(["proactive-heartbeat-daemon-loop.json"]);
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore);
  });

  it("--once records a fresh daemon-loop heartbeat mark, distinct from proactive's own alive/fired", async () => {
    const env = tmpEnv();
    writeFileSync(env.MUSE_TASKS_FILE!, JSON.stringify({ tasks: [] }), "utf8");
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);

    const before = Date.now();
    const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], { env, registry });
    expect(res.exitCode).toBeUndefined();

    // MUSE_PROACTIVE_SIDECAR_FILE lives directly under the heartbeat dir
    // (defaultProactiveHeartbeatDir mirrors this), so its dirname is where
    // ALL heartbeat marks — alive/fired AND daemon-loop — land.
    const heartbeatDir = dirname(env.MUSE_PROACTIVE_SIDECAR_FILE!);
    const heartbeat = await readProactiveHeartbeat(heartbeatDir);
    expect(heartbeat.daemonLoop).toBeDefined();
    expect(Date.parse(heartbeat.daemonLoop!.at)).toBeGreaterThanOrEqual(before);
    expect(heartbeat.daemonLoop!.pid).toBe(process.pid);
  });

  it("each daemon-loop round writes a NEWER mark (runDaemonLoop ticks it every round)", async () => {
    const env = tmpEnv();
    writeFileSync(env.MUSE_TASKS_FILE!, JSON.stringify({ tasks: [] }), "utf8");
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);
    const heartbeatDir = dirname(env.MUSE_PROACTIVE_SIDECAR_FILE!);

    await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], { env, registry });
    const first = (await readProactiveHeartbeat(heartbeatDir)).daemonLoop!.at;

    await new Promise((resolve) => setTimeout(resolve, 5));
    await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], { env, registry });
    const second = (await readProactiveHeartbeat(heartbeatDir)).daemonLoop!.at;

    expect(Date.parse(second)).toBeGreaterThan(Date.parse(first));
  });
});

describe("muse daemon — resource admission", () => {
  it("runs the isolated active -> idle claim -> owner-paused three-cycle journey", async () => {
    const env: NodeJS.ProcessEnv = {
      ...tmpEnv(),
      MUSE_DAEMON_BACKGROUND_MODE: "auto",
      MUSE_EMAIL_SYNC_ENABLED: "true",
      MUSE_MESSAGING_POLL_ENABLED: "true"
    };
    const heavy = vi.fn();
    const messagingPoll = vi.fn(async () => ({ errors: [], ingestedByProvider: {} }));
    const receipts: DaemonResourceReceipt[] = [];
    const snapshots: DaemonResourceSnapshot[] = [
      { cpuCount: 4, freeMemoryBytes: 4 * 1024 ** 3, idleMs: 1_000, load1: 1, onAcPower: true, platform: "darwin" },
      { cpuCount: 4, freeMemoryBytes: 4 * 1024 ** 3, idleMs: 300_000, load1: 1, onAcPower: true, platform: "darwin" },
      { cpuCount: 4, freeMemoryBytes: 4 * 1024 ** 3, idleMs: 300_000, load1: 1, onAcPower: true, platform: "darwin" }
    ];
    const makeEmailSyncTick: NonNullable<DaemonHelpers["makeEmailSyncTick"]> = () => async (claim) => {
      if (!(claim ?? (() => true))()) return { status: "cancelled-before-claim" };
      heavy();
      return { status: "claimed-completed" };
    };

    await runDaemon(["--provider", "telegram", "--destination", "555"], {
      env,
      makeEmailSyncTick,
      messagingPoll,
      registry: new MessagingProviderRegistry([capturingProvider([])]),
      resourceSnapshot: () => snapshots.shift()!,
      runDaemonLoop: async ({ signal, tick }) => {
        await tick();
        await tick();
        env.MUSE_DAEMON_BACKGROUND_MODE = "paused";
        await tick();
        signal.stop();
        return 3;
      },
      writeResourceAdmissionReceipt: async (_file, receipt) => { receipts.push(receipt); }
    });

    expect(heavy).toHaveBeenCalledOnce();
    expect(messagingPoll).toHaveBeenCalled();
    expect(receipts).toMatchObject([
      { decision: { reason: "active-user", status: "deferred" } },
      { decision: { status: "admitted" } },
      { decision: { status: "admitted" }, lastBoundary: { status: "completed", unit: "pattern" } },
      { decision: { status: "admitted" }, lastBoundary: { status: "completed", unit: "email-sync" } },
      { decision: { reason: "owner-paused", status: "deferred" } }
    ]);
    expect(JSON.parse(readFileSync(join(env.HOME!, ".muse", "daemon-workload-profile.json"), "utf8"))).toMatchObject({
      admitted: 2,
      boundaries: 2,
      deferred: 2,
      units: { "email-sync": { completed: 1, failed: 0 }, pattern: { completed: 1, failed: 0 } }
    });
  });

  it("defers and then resumes opt-in heavyweight browsing sync without changing the light tick", async () => {
    const env: NodeJS.ProcessEnv = {
      ...tmpEnv(),
      MUSE_BROWSING_AUTO_SYNC: "true",
      MUSE_DAEMON_DELIVERY_ENABLED: "true"
    };
    const registry = new MessagingProviderRegistry([capturingProvider([])]);
    let calls = 0;
    const receipts: unknown[] = [];
    const snapshots = [
      { cpuCount: 4, freeMemoryBytes: 4 * 1024 * 1024 * 1024, load1: 4 },
      { cpuCount: 4, freeMemoryBytes: 4 * 1024 * 1024 * 1024, load1: 4 },
      { cpuCount: 4, freeMemoryBytes: 4 * 1024 * 1024 * 1024, load1: 1 }
    ];
    const result = await runDaemon(["--provider", "telegram", "--destination", "555"], {
      browsingSync: async () => { calls += 1; return { synced: 0, total: 0 }; },
      env,
      registry,
      resourceSnapshot: () => snapshots.shift() ?? { cpuCount: 4, freeMemoryBytes: 4 * 1024 * 1024 * 1024, load1: 1 },
      writeResourceAdmissionReceipt: async (_file, receipt) => { receipts.push(receipt); },
      runDaemonLoop: async ({ signal, tick }) => {
        await tick();
        await tick();
        await tick();
        signal.stop();
        return 3;
      }
    });

    expect(result.exitCode).toBeUndefined();
    expect(calls).toBe(1);
    expect(receipts).toHaveLength(4);
    expect(receipts).toMatchObject([
      { decision: { reason: "cpu-load", status: "deferred" } },
      { decision: { status: "admitted" } },
      { decision: { status: "admitted" }, lastBoundary: { status: "completed", unit: "pattern" } },
      { decision: { status: "admitted" }, lastBoundary: { status: "completed", unit: "browsing-sync" } }
    ]);
    expect(result.stdout).toContain("resource: deferred heavyweight background work (cpu-load)");
    expect(result.stdout).toContain("resource: heavyweight background work resumed");
  });

  it("applies the cap across delivery and maintenance with one fair cursor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 12, 18, 5, 0));
    const env: NodeJS.ProcessEnv = {
      ...tmpEnv(),
      MUSE_BROWSING_AUTO_SYNC: "true",
      MUSE_DAEMON_DELIVERY_ENABLED: "true",
      MUSE_DAEMON_HEAVY_WORK_UNITS_PER_TICK: "1"
    };
    const registry = new MessagingProviderRegistry([capturingProvider([])]);
    let browsingCalls = 0;
    const receipts: DaemonResourceReceipt[] = [];
    try {
      const result = await runDaemon(["--provider", "telegram", "--destination", "555"], {
        browsingSync: async () => { browsingCalls += 1; return { synced: 0, total: 0 }; },
        env,
        registry,
        resourceSnapshot: () => ({ cpuCount: 4, freeMemoryBytes: 4 * 1024 * 1024 * 1024, load1: 1 }),
        runDaemonLoop: async ({ signal, tick }) => {
          await tick();
          expect(browsingCalls).toBe(0);
          await tick();
          signal.stop();
          return 2;
        },
        writeResourceAdmissionReceipt: async (_file, receipt) => { receipts.push(receipt); }
      });

      expect(result.exitCode).toBeUndefined();
      expect(browsingCalls).toBe(1);
      expect(receipts.flatMap((receipt) => "lastBoundary" in receipt && receipt.lastBoundary ? [receipt.lastBoundary.unit] : [])).toEqual([
        "pattern",
        "browsing-sync"
      ]);
      expect(receipts.some((receipt) => "lastBoundary" in receipt && receipt.lastBoundary?.unit === "digest-flush")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-reads owner pause each tick, defers heavy work, and resumes without a restart", async () => {
    const env: NodeJS.ProcessEnv = {
      ...tmpEnv(),
      MUSE_BROWSING_AUTO_SYNC: "true",
      MUSE_DAEMON_DELIVERY_ENABLED: "true"
    };
    writeFileSync(env.MUSE_DAEMON_CONFIG_FILE!, JSON.stringify({ heavyWorkPaused: true }), "utf8");
    const registry = new MessagingProviderRegistry([capturingProvider([])]);
    const receipts: unknown[] = [];
    let calls = 0;
    const result = await runDaemon(["--provider", "telegram", "--destination", "555"], {
      browsingSync: async () => { calls += 1; return { synced: 0, total: 0 }; },
      env,
      registry,
      resourceSnapshot: () => ({ cpuCount: 4, freeMemoryBytes: 4 * 1024 * 1024 * 1024, load1: 1 }),
      runDaemonLoop: async ({ signal, tick }) => {
        await tick();
        writeFileSync(env.MUSE_DAEMON_CONFIG_FILE!, "{}\n", "utf8");
        await tick();
        signal.stop();
        return 2;
      },
      writeResourceAdmissionReceipt: async (_file, receipt) => { receipts.push(receipt); }
    });

    expect(result.exitCode).toBeUndefined();
    expect(calls).toBe(1);
    expect(receipts).toMatchObject([
      { decision: { reason: "owner-paused", status: "deferred" } },
      { decision: { status: "admitted" } },
      { decision: { status: "admitted" }, lastBoundary: { status: "completed", unit: "pattern" } },
      { decision: { status: "admitted" }, lastBoundary: { status: "completed", unit: "browsing-sync" } }
    ]);
    expect(result.stdout).toContain("resource: deferred heavyweight background work (owner-paused)");
    expect(result.stdout).toContain("resource: heavyweight background work resumed");
  });

  it("does not invoke a due followup model while the owner pause is active", async () => {
    const env: NodeJS.ProcessEnv = {
      ...tmpEnv(),
      MUSE_DAEMON_DELIVERY_ENABLED: "true"
    };
    writeFileSync(env.MUSE_DAEMON_CONFIG_FILE!, JSON.stringify({ heavyWorkPaused: true }), "utf8");
    await writeFollowups(env.MUSE_FOLLOWUPS_FILE!, [
      { createdAt: "2026-01-01T00:00:00Z", id: "fu-owner-pause", scheduledFor: "2026-01-02T00:00:00Z", status: "scheduled", summary: "Do not call the model", userId: "stark" }
    ]);
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);
    let modelCalls = 0;
    const result = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], {
      env,
      registry,
      resourceSnapshot: () => ({ cpuCount: 4, freeMemoryBytes: 4 * 1024 * 1024 * 1024, load1: 1 }),
      resolveFollowupModel: async () => ({
        model: "test-model",
        modelProvider: {
          generate: async () => {
            modelCalls += 1;
            return { output: "must not be generated" };
          }
        } as never
      })
    });

    expect(result.exitCode).toBeUndefined();
    expect(modelCalls).toBe(0);
    expect(sent).toHaveLength(0);
    expect(result.stdout).not.toContain("followup:");
    expect(result.stdout).not.toContain("pattern:");
    expect(result.stdout).not.toContain("objectives:");
  });

  it("does not initialize heavy resolvers while paused, then initializes each once after admission", async () => {
    const env: NodeJS.ProcessEnv = {
      ...tmpEnv(),
      MUSE_DAEMON_DELIVERY_ENABLED: "true",
      MUSE_WEB_WATCH_CONFIG: JSON.stringify([
        { id: "lazy-chrome", message: "changed", rule: { appears: "changed" }, source: "chrome", title: "Lazy", url: "https://example.test" }
      ])
    };
    writeFileSync(env.MUSE_DAEMON_CONFIG_FILE!, JSON.stringify({ heavyWorkPaused: true }), "utf8");
    const registry = new MessagingProviderRegistry([capturingProvider([])]);
    const calls = { chrome: 0, knowledge: 0, model: 0 };

    const result = await runDaemon(["--provider", "telegram", "--destination", "555"], {
      env,
      registry,
      resolveChromeConnection: async () => { calls.chrome += 1; return undefined; },
      resolveFollowupModel: async () => { calls.model += 1; return undefined; },
      resolveKnowledgeEnrich: async () => { calls.knowledge += 1; return undefined; },
      resourceSnapshot: () => ({ cpuCount: 4, freeMemoryBytes: 4 * 1024 * 1024 * 1024, load1: 1 }),
      runDaemonLoop: async ({ signal, tick }) => {
        await tick();
        expect(calls).toEqual({ chrome: 0, knowledge: 0, model: 0 });
        writeFileSync(env.MUSE_DAEMON_CONFIG_FILE!, "{}\n", "utf8");
        await tick();
        await tick();
        signal.stop();
        return 3;
      }
    });

    expect(result.exitCode).toBeUndefined();
    expect(calls).toEqual({ chrome: 1, knowledge: 1, model: 1 });
  });

  it("owner pause starts zero heavyweight units while light polling still runs", async () => {
    const env = { ...tmpEnv(), MUSE_BROWSING_AUTO_SYNC: "true", MUSE_DAEMON_BACKGROUND_MODE: "paused", MUSE_MESSAGING_POLL_ENABLED: "true" };
    const browsingSync = vi.fn(async () => ({ synced: 0, total: 0 }));
    const messagingPoll = vi.fn(async () => ({ errors: [], ingestedByProvider: {} }));
    const receipts: DaemonResourceReceipt[] = [];
    await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], {
      browsingSync,
      env,
      messagingPoll,
      registry: new MessagingProviderRegistry([capturingProvider([])]),
      writeResourceAdmissionReceipt: async (_file, receipt) => { receipts.push(receipt); }
    });
    expect(browsingSync).not.toHaveBeenCalled();
    expect(messagingPoll).toHaveBeenCalledOnce();
    expect(receipts[0]).toMatchObject({ decision: { reason: "owner-paused", status: "deferred" } });
  });

  it("does not start a unit if stop arrives during the admission receipt await", async () => {
    const env = { ...tmpEnv(), MUSE_EMAIL_SYNC_ENABLED: "true" };
    const heavy = vi.fn();
    let signal: DaemonStopSignal | undefined;
    const makeEmailSyncTick: NonNullable<DaemonHelpers["makeEmailSyncTick"]> = () => async (claim) => {
      if (!(claim ?? (() => true))()) return { status: "cancelled-before-claim" };
      heavy();
      return { status: "claimed-completed" };
    };
    await runDaemon(["--provider", "telegram", "--destination", "555"], {
      env,
      makeEmailSyncTick,
      registry: new MessagingProviderRegistry([capturingProvider([])]),
      runDaemonLoop: async (options) => { signal = options.signal; await options.tick(); return 0; },
      writeResourceAdmissionReceipt: async () => { signal?.stop(); }
    });
    expect(heavy).not.toHaveBeenCalled();
  });

  it("starts no later outer lane when the first admitted lane requests stop", async () => {
    const env: NodeJS.ProcessEnv = { ...tmpEnv(), MUSE_BROWSING_AUTO_SYNC: "true" };
    await writeFollowups(env.MUSE_FOLLOWUPS_FILE!, [
      { createdAt: "2026-01-01T00:00:00Z", id: "fu-stop-outer", scheduledFor: "2026-01-02T00:00:00Z", status: "scheduled", summary: "stop after this lane", userId: "owner" }
    ]);
    const browsingSync = vi.fn(async () => ({ synced: 0, total: 0 }));
    const receipts: DaemonResourceReceipt[] = [];
    let modelCalls = 0;
    let signal: DaemonStopSignal | undefined;
    await runDaemon(["--provider", "telegram", "--destination", "555"], {
      browsingSync,
      env,
      registry: new MessagingProviderRegistry([capturingProvider([])]),
      resolveFollowupModel: async () => ({
        model: "test-model",
        modelProvider: {
          generate: async () => {
            modelCalls += 1;
            signal?.stop();
            return { output: "completed first lane" };
          }
        } as never
      }),
      runDaemonLoop: async (options) => { signal = options.signal; await options.tick(); return 1; },
      writeResourceAdmissionReceipt: async (_file, receipt) => { receipts.push(receipt); }
    });
    expect(modelCalls).toBe(1);
    expect(browsingSync).not.toHaveBeenCalled();
    expect(receipts.at(-1)).toMatchObject({
      decision: { status: "admitted" },
      lastBoundary: { status: "completed", stopRequestedDuring: true, unit: "followup" }
    });
  });

  it("finishes a claimed unit truthfully after stop and skips following optional ticks", async () => {
    const env = { ...tmpEnv(), MUSE_EMAIL_SYNC_ENABLED: "true" };
    const messagingPoll = vi.fn(async () => ({ errors: [], ingestedByProvider: {} }));
    const receipts: DaemonResourceReceipt[] = [];
    let signal: DaemonStopSignal | undefined;
    const makeEmailSyncTick: NonNullable<DaemonHelpers["makeEmailSyncTick"]> = () => async (claim) => {
      if (!(claim ?? (() => true))()) return { status: "cancelled-before-claim" };
      signal?.stop();
      return { status: "claimed-completed" };
    };
    await runDaemon(["--provider", "telegram", "--destination", "555"], {
      env,
      makeEmailSyncTick,
      messagingPoll,
      registry: new MessagingProviderRegistry([capturingProvider([])]),
      runDaemonLoop: async (options) => { signal = options.signal; await options.tick(); return 1; },
      writeResourceAdmissionReceipt: async (_file, receipt) => { receipts.push(receipt); }
    });
    expect(messagingPoll).not.toHaveBeenCalled();
    expect(receipts.at(-1)).toMatchObject({ lastBoundary: { status: "completed", stopRequestedDuring: true, unit: "email-sync" } });
  });
});

describe("runDaemonLoop — foreground loop shuts down cleanly on a stop signal", () => {
  it("runs ticks until the signal stops, then returns the tick count (no hang, no process.exit)", async () => {
    const signal = new DaemonStopSignal();
    let ticks = 0;
    let sleeps = 0;
    const ran = await runDaemonLoop({
      intervalMs: 1000,
      signal,
      sleep: async () => { sleeps += 1; if (sleeps >= 2) signal.stop(); },
      tick: async () => { ticks += 1; }
    });
    expect(ran).toBe(2);
    expect(ticks).toBe(2);
  });

  it("a throwing tick is reported but does NOT stop the loop (unattended daemon survives)", async () => {
    const signal = new DaemonStopSignal();
    const errors: unknown[] = [];
    let ticks = 0;
    await runDaemonLoop({
      intervalMs: 1000,
      onError: (e) => errors.push(e),
      signal,
      sleep: async () => { signal.stop(); },
      tick: async () => { ticks += 1; throw new Error("tick boom"); }
    });
    expect(ticks).toBe(1);
    expect(errors).toHaveLength(1);
  });

  it("an already-stopped signal runs zero ticks", async () => {
    const signal = new DaemonStopSignal();
    signal.stop(123);
    signal.stop(456);
    expect(signal.requestedAtMs).toBe(123);
    const ran = await runDaemonLoop({ intervalMs: 1000, signal, sleep: async () => undefined, tick: async () => undefined });
    expect(ran).toBe(0);
  });

  it("the interruptible sleep resolves immediately when stopped instead of waiting out the interval", async () => {
    const signal = new DaemonStopSignal();
    const started = Date.now();
    const pending = signal.sleep(60_000);
    signal.stop();
    await pending;
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("buildLaunchAgentPlist — resident daemon via launchd", () => {
  it("produces a plutil-valid plist that runs at load, keeps alive, and invokes `daemon`", () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-plist-"));
    const file = join(dir, "com.muse.daemon.plist");
    const xml = buildLaunchAgentPlist({
      label: "com.muse.daemon",
      programArguments: ["/usr/local/bin/node", "/opt/muse/cli.js", "daemon"],
      stderrPath: join(dir, "err.log"),
      stdoutPath: join(dir, "out.log")
    });
    writeFileSync(file, xml, "utf8");

    expect(xml).toContain("<string>com.muse.daemon</string>");
    expect(xml).toContain("<key>RunAtLoad</key>");
    expect(xml).toContain("<key>KeepAlive</key>");
    // ProcessType Background marks the learning daemon low-priority (B1 §7).
    expect(xml).toContain("<key>ProcessType</key>");
    expect(xml).toContain("<string>Background</string>");
    expect(xml).toContain("<string>daemon</string>");
    // LowPriorityIO throttles disk I/O contention with the user's own work.
    expect(xml).toContain("<key>LowPriorityIO</key>");
    if (process.platform === "darwin") {
      expect(() => execFileSync("plutil", ["-lint", file], { encoding: "utf8" })).not.toThrow();
    }
  });

  it("xml-escapes a path containing reserved characters", () => {
    const xml = buildLaunchAgentPlist({
      label: "com.muse.daemon",
      programArguments: ["/bin/sh", "-c", "echo a && echo <b>"],
      stderrPath: "/tmp/err.log",
      stdoutPath: "/tmp/out.log"
    });
    expect(xml).toContain("echo a &amp;&amp; echo &lt;b&gt;");
    expect(xml).not.toContain("echo a && echo <b>");
  });
});

describe("parseLaunchctlListInfo — distinguish RUNNING from registered-but-crash-looping", () => {
  it("extracts the pid from a real launchd `list <label>` dump when the job is running", () => {
    const stdout = '{\n\t"StandardOutPath" = "/x/out.log";\n\t"LastExitStatus" = 0;\n\t"PID" = 1234;\n\t"Label" = "com.muse.daemon";\n};\n';
    expect(parseLaunchctlListInfo(stdout)).toEqual({ lastExitStatus: 0, pid: 1234 });
  });

  it("reports NO pid + a non-zero LastExitStatus when the job is registered but crash-looping", () => {
    const stdout = '{\n\t"LastExitStatus" = 78;\n\t"Label" = "com.muse.daemon";\n};\n';
    expect(parseLaunchctlListInfo(stdout)).toEqual({ lastExitStatus: 78 });
  });

  it("ignores a pid of 0 (never a real running process id)", () => {
    const stdout = '{\n\t"LastExitStatus" = 0;\n\t"PID" = 0;\n};\n';
    expect(parseLaunchctlListInfo(stdout)).toEqual({ lastExitStatus: 0 });
  });

  it("returns an empty result for a not-found label (unload confirmed / never installed)", () => {
    expect(parseLaunchctlListInfo("")).toEqual({});
    expect(parseLaunchctlListInfo("Could not find specified service")).toEqual({});
  });
});

describe("validateDaemonCliEntry — persistent service entries must be stable", () => {
  it("rejects missing, relative, and nonexistent entries deterministically", () => {
    expect(validateDaemonCliEntry(undefined)).toEqual({ ok: false, reason: "the Muse CLI entrypoint is missing" });
    expect(validateDaemonCliEntry("apps/cli/dist/index.js")).toMatchObject({ ok: false });
    expect(validateDaemonCliEntry("/definitely/missing/muse/index.js")).toMatchObject({ ok: false });
  });

  it("accepts an existing absolute entry outside the injected temporary roots", () => {
    const unrelatedTempRoot = mkdtempSync(join(tmpdir(), "muse-entry-other-temp-"));
    const result = validateDaemonCliEntry(TEST_HARNESS_CLI_ENTRY, { temporaryRoots: [unrelatedTempRoot] });
    expect(result).toMatchObject({ ok: true });
  });

  it("rejects an installed Vitest entrypoint before any service-manager call", async () => {
    const vitestEntry = fileURLToPath(import.meta.resolve("vitest"));
    const calls: (readonly string[])[] = [];
    const plistFile = join(mkdtempSync(join(tmpdir(), "muse-install-test-runner-")), "com.muse.daemon.plist");
    const result = await runDaemon(["--install"], {
      daemonCliEntry: vitestEntry,
      env: { ...tmpEnv(), MUSE_DAEMON_PLIST_FILE: plistFile },
      platform: "darwin",
      registry: new MessagingProviderRegistry([capturingProvider([])]),
      runLaunchctl: async (args) => {
        calls.push(args);
        return { code: 0, stderr: "", stdout: "" };
      }
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("test-runner worker");
    expect(calls).toEqual([]);
    expect(existsSync(plistFile)).toBe(false);
  });
});

describe("chromeSnapshotConnectionFromTools — adapt MCP tools into a web-watch Chrome connection", () => {
  it("forwards callTool to the chrome-devtools.<name> MuseTool's execute", async () => {
    const conn = chromeSnapshotConnectionFromTools(fakeChromeTools("Order: SHIPPED"));
    await conn.callTool("navigate_page", { url: "https://x.example" });
    const snap = await conn.callTool("take_snapshot", {});
    expect(snap).toBe("Order: SHIPPED");
  });

  it("throws for a tool the connected server does not expose", async () => {
    const conn = chromeSnapshotConnectionFromTools([]);
    await expect(conn.callTool("take_snapshot", {})).rejects.toThrow(/not available/);
  });

  it("drives a daemon source:chrome watch end-to-end through the adapter", async () => {
    const env: NodeJS.ProcessEnv = { ...tmpEnv(), MUSE_WEB_WATCH_CONFIG: JSON.stringify([
      { id: "w1", url: "https://orders.example/1", title: "Order", message: "Your order shipped", source: "chrome", rule: { appears: "SHIPPED" } }
    ]) };
    writeFileSync(env.MUSE_TASKS_FILE!, JSON.stringify({ tasks: [] }), "utf8");
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);
    const chromeConnection = chromeSnapshotConnectionFromTools(fakeChromeTools("Order status: SHIPPED"));

    const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], { chromeConnection, env, registry });

    expect(res.exitCode).toBeUndefined();
    expect(res.stdout).toMatch(/web-watch: delivered 1/);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("order shipped");
  });
});

// N2 — ③/② end-to-end daemon audit: prove the autonomous pieces COMPOSE in one
// real `--once` tick (check-in delivery + pattern suggestion together), and that
// quiet-hours and dedup hold across the composed daemon — not just per-unit.
describe("muse daemon — N2 audit: check-ins + pattern suggestion compose in ONE tick", () => {
  // aggregateActivitySignals reads process.env.HOME (the daemon's pattern tick
  // forwards no signal paths), so the note fixture must live under a stubbed
  // HOME. The check-in / patterns-fired files are pinned via explicit env.
  let home: string;
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function n2Env(): NodeJS.ProcessEnv {
    home = mkdtempSync(join(tmpdir(), "muse-n2-home-"));
    vi.stubEnv("HOME", home);
    return {
      ...tmpEnv(),
      MUSE_CHECKINS_FILE: join(home, "checkins.json"),
      MUSE_PATTERNS_FIRED_FILE: join(home, "patterns-fired.json")
    };
  }

  // 5 weekly journal notes at exactly now − 7·k days: each lands on today's
  // weekday + hour, so the detected weekly slot == "now" regardless of when the
  // test runs (real clock — the daemon exposes no `now` seam). → one fireable.
  async function seedWeeklyNotePattern(): Promise<void> {
    const journal = join(home, ".muse", "notes", "journal");
    await mkdir(journal, { recursive: true });
    const nowMs = Date.now();
    for (let k = 1; k <= 5; k += 1) {
      const file = join(journal, `entry-${k.toString()}.md`);
      await writeFile(file, `journal ${k.toString()}`, "utf8");
      const when = new Date(nowMs - k * 7 * 86_400_000);
      await utimes(file, when, when);
    }
  }

  async function seedDueCheckin(env: NodeJS.ProcessEnv): Promise<string> {
    const commitment = "email Bob about the Q3 report";
    const past = new Date(Date.now() - 60 * 60_000).toISOString();
    const checkin: PersistedCheckin = {
      commitment,
      createdAt: past,
      dueAtIso: past,
      id: "ci-1",
      question: buildCheckinQuestion(commitment),
      sourceKey: commitment.toLowerCase(),
      status: "scheduled",
      userId: "stark"
    };
    await writeCheckins(env.MUSE_CHECKINS_FILE!, [checkin]);
    return checkin.question;
  }

  // Quiet-hours window that contains the current local hour (inclusive start).
  function quietWindowCoveringNow(): string {
    const h = new Date().getHours();
    return `${h.toString()}-${((h + 1) % 24).toString()}`;
  }

  it("one --once tick delivers BOTH a due check-in AND a pattern suggestion to the same sink", async () => {
    const env = n2Env();
    await seedWeeklyNotePattern();
    const question = await seedDueCheckin(env);
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);

    const res = await runDaemon(
      ["--once", "--provider", "telegram", "--destination", "555"],
      { env, registry, resolveFollowupModel: async () => fakeFollowupModel() }
    );

    expect(res.exitCode).toBeUndefined();
    expect(res.stdout).toMatch(/checkins: fired 1\/1 due/);
    expect(res.stdout).toMatch(/pattern: delivered 1\/1 fireable/);
    expect(sent).toHaveLength(2);
    expect(sent.every((m) => m.destination === "555")).toBe(true);
    expect(sent.map((m) => m.text)).toContain(question);
    // The other message is the pattern suggestion — distinct from the check-in.
    expect(sent.filter((m) => m.text !== question)).toHaveLength(1);
  });

  it("quiet hours hold BOTH the check-in and the pattern in the composed tick — no send", async () => {
    const env: NodeJS.ProcessEnv = { ...n2Env(), MUSE_PROACTIVE_QUIET_HOURS: quietWindowCoveringNow() };
    await seedWeeklyNotePattern();
    await seedDueCheckin(env);
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);

    const res = await runDaemon(
      ["--once", "--provider", "telegram", "--destination", "555"],
      { env, registry, resolveFollowupModel: async () => fakeFollowupModel() }
    );

    expect(res.exitCode).toBeUndefined();
    expect(res.stdout).toMatch(/checkins: fired 0\/0 due/);
    expect(res.stdout).toMatch(/pattern: held \(quiet hours\)/);
    expect(sent).toHaveLength(0);
  });

  it("dedup: a second --once tick re-delivers neither the check-in nor the pattern", async () => {
    const env = n2Env();
    await seedWeeklyNotePattern();
    await seedDueCheckin(env);
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);
    const args = ["--once", "--provider", "telegram", "--destination", "555"];
    const opts = { env, registry, resolveFollowupModel: async () => fakeFollowupModel() };

    await runDaemon(args, opts);
    expect(sent).toHaveLength(2); // first tick: check-in + pattern

    const res2 = await runDaemon(args, opts);
    expect(res2.stdout).toMatch(/checkins: fired 0\/0 due/);
    expect(res2.stdout).toMatch(/pattern: delivered 0\/0 fireable/);
    expect(sent).toHaveLength(2); // second tick: nothing new — both deduped
  });
});

// A model that returns reflection JSON citing the seeded episode ids — only the
// model's TEXT is faked; the real synthesizeReflections → addReflections → store
// path runs, so this proves the daemon actually dreams, not a stubbed registry.
// The synthesis call gets the JSON; the RGV re-verification judge call (added in
// the reflection-grounding slice) gets a "YES" — the seeded insight IS grounded
// in its networking episodes, so a faithful judge upholds it.
function fakeReflectionModel(): NonNullable<Awaited<ReturnType<NonNullable<DaemonHelpers["resolveFollowupModel"]>>>> {
  return {
    model: "test-model",
    modelProvider: {
      generate: async (request: { readonly messages?: ReadonlyArray<{ readonly content?: string }> }) => {
        const isGroundingJudge = (request.messages ?? []).some((m) => /grounding judge|Reply YES or NO/iu.test(m.content ?? ""));
        return {
          output: isGroundingJudge
            ? "YES"
            : '[{"insight":"You troubleshoot home networking often","sources":["e1","e2","e3"]}]'
        };
      }
    } as never
  };
}

async function seedDreamEpisodes(file: string): Promise<void> {
  const ep = (id: string, summary: string): PersistedEpisode => ({
    endedAt: "2026-05-20T10:00:00Z", id, startedAt: "2026-05-20T09:00:00Z", summary, userId: "local"
  });
  await writeEpisodes(file, [
    ep("e1", "Fixed the office VPN handshake by setting MTU 1380 on wg0."),
    ep("e2", "Debugged wireguard keepalive dropping behind the home router."),
    ep("e3", "Tuned the LAN DNS so the NAS resolves locally.")
  ]);
}

describe("muse daemon — grounded dreaming tick", () => {
  it("auto-synthesises + persists a GROUNDED reflection while idle when enabled", async () => {
    const env = tmpEnv();
    const dir = mkdtempSync(join(tmpdir(), "muse-dream-"));
    env.MUSE_EPISODES_FILE = join(dir, "episodes.json");
    env.MUSE_REFLECTIONS_FILE = join(dir, "reflections.json");
    env.MUSE_REFLECTION_ENABLED = "true";
    await seedDreamEpisodes(env.MUSE_EPISODES_FILE);
    const registry = new MessagingProviderRegistry([capturingProvider([])]);

    const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], {
      env, registry, resolveFollowupModel: async () => fakeReflectionModel()
    });

    expect(res.stdout).toMatch(/reflections: \+1/);
    const stored = await readReflections(env.MUSE_REFLECTIONS_FILE);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.insight).toContain("networking");
    expect([...stored[0]!.sourceIds].sort()).toEqual(["e1", "e2", "e3"]); // grounded only in real episodes
  });

  it("does NOTHING when MUSE_REFLECTION_ENABLED is unset (gate is real — off by default)", async () => {
    const env = tmpEnv();
    const dir = mkdtempSync(join(tmpdir(), "muse-dream-off-"));
    env.MUSE_EPISODES_FILE = join(dir, "episodes.json");
    env.MUSE_REFLECTIONS_FILE = join(dir, "reflections.json");
    await seedDreamEpisodes(env.MUSE_EPISODES_FILE);
    const registry = new MessagingProviderRegistry([capturingProvider([])]);

    const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], {
      env, registry, resolveFollowupModel: async () => fakeReflectionModel()
    });

    expect(res.stdout).not.toContain("reflections:");
    expect(await readReflections(env.MUSE_REFLECTIONS_FILE)).toHaveLength(0);
  });
});

describe("muse daemon — unattended self-learning tick", () => {
  // A correction the user made in a past session, queued at correction time.
  async function seedCorrection(env: NodeJS.ProcessEnv): Promise<void> {
    await enqueueLearnEvent(env.MUSE_LEARN_QUEUE_FILE!, {
      id: "lc1",
      userId: "u1",
      priorAnswer: "Your standup is at 10am.",
      correction: "No — standup moved to 9:30am on Mondays.",
      enqueuedAtMs: 1
    });
  }
  // Deterministic distiller so the round-trip needs no live LLM.
  const fakeDistill: NonNullable<DaemonHelpers["selfLearnDistill"]> = async () =>
    ({ tag: "scheduling", text: "Monday standup is at 9:30am, not 10am." });

  it("distills a queued correction into a strategy with NO manual command, drains the queue, AND tells the user on their channel", async () => {
    const env = tmpEnv();
    env.MUSE_SELFLEARN_ENABLED = "true";
    await seedCorrection(env);
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);

    const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], {
      env, registry, resolveFollowupModel: async () => fakeFollowupModel(), selfLearnDistill: fakeDistill
    });

    expect(res.stdout).toMatch(/learned: \+1 strategy from your corrections/);
    expect(await readPendingLearnEvents(env.MUSE_LEARN_QUEUE_FILE!)).toHaveLength(0); // consumed
    // FELT: the autonomous learning is DELIVERED to the user's channel,
    // not just the daemon console — and it's honest that nothing auto-applies.
    const learnNotice = sent.find((m) => m.text.includes("Learned from your corrections"));
    expect(learnNotice, "the daemon must surface its autonomous learning to the user").toBeDefined();
    expect(learnNotice!.text).toContain("muse learned");
    expect(learnNotice!.text).toContain("until you reinforce it");
  });

  // SUBTRACTIVE correction-decay: a NEW correction that CONTRADICTS an
  // injected strategy autonomously drops it below the inject line, unattended.
  //
  // lastReinforcedAt is pinned to "now" (not a fixed past date) so this
  // fixture never crosses decayStalePlaybookRewards' 30-day staleness
  // threshold (PLAYBOOK_DECAY_STALE_DAYS) as real calendar time passes —
  // the daemon's disuse-decay tick runs unconditionally on every `--once`
  // invocation (module-scope `lastDecayMs` starts undefined) whenever
  // MUSE_SELFLEARN_ENABLED is set, independent of the contradiction
  // classifier this test/its sibling actually exercise. Without a fresh
  // anchor, a hardcoded createdAt eventually goes stale and the disuse tick
  // silently shaves an extra -1 off the reward the contradiction path
  // never touched — exactly the flake this suite must stay hermetic against.
  const seedInjected = async (env: NodeJS.ProcessEnv): Promise<void> => {
    const now = new Date().toISOString();
    await writePlaybook(env.MUSE_PLAYBOOK_FILE!, [
      // origin "distilled" = a strategy MUSE inferred. A user-authored (manual) or
      // evidence-grounded rule is deliberately NOT decayable by the unattended path
      // (see isUserAuthoredStrategy) — that is pinned in decay-contradicted.test.ts.
      { createdAt: "2026-06-01T00:00:00Z", id: "inj1", lastReinforcedAt: now, origin: "distilled", probation: false, reward: 3, text: "Always give a long, detailed multi-paragraph answer.", userId: "u1" }
    ]);
  };

  it("autonomously DECAYS an injected strategy a new correction CONTRADICTS (subtractive + felt), never graduating it", async () => {
    const env = tmpEnv();
    env.MUSE_SELFLEARN_ENABLED = "true";
    await seedInjected(env);
    await seedCorrection(env);
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);

    const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], {
      env, registry, resolveFollowupModel: async () => fakeFollowupModel(),
      selfLearnDistill: fakeDistill, contradictionClassify: async () => "contradict"
    });

    expect(res.stdout).toMatch(/unlearned: stopped applying 1 strategy you contradicted/);
    const inj = (await readPlaybook(env.MUSE_PLAYBOOK_FILE!)).find((e) => e.id === "inj1")!;
    expect(inj.reward).toBe(-4); // dropped to the avoid floor → no longer injected
    expect(inj.probation).toBe(false); // decay-only — it did NOT graduate or re-probation
    const notice = sent.find((m) => m.text.includes("stopped applying"));
    expect(notice, "the user is told a contradicted preference was dropped").toBeDefined();
    expect(notice!.text).toContain("muse playbook reward"); // and how to reverse it
  });

  it("does NOT decay when the new correction does NOT contradict the injected strategy (fail-closed)", async () => {
    const env = tmpEnv();
    env.MUSE_SELFLEARN_ENABLED = "true";
    await seedInjected(env);
    await seedCorrection(env);
    const registry = new MessagingProviderRegistry([capturingProvider([])]);

    const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], {
      env, registry, resolveFollowupModel: async () => fakeFollowupModel(),
      selfLearnDistill: fakeDistill, contradictionClassify: async () => "unrelated"
    });

    expect(res.stdout).not.toContain("unlearned:");
    expect((await readPlaybook(env.MUSE_PLAYBOOK_FILE!)).find((e) => e.id === "inj1")!.reward).toBe(3); // untouched, still applied
  });

  it("BRAKE: learns nothing and leaves the queue intact when learning is paused", async () => {
    const env = tmpEnv();
    env.MUSE_SELFLEARN_ENABLED = "true";
    await seedCorrection(env);
    await setLearningPaused(env.MUSE_LEARNING_PAUSE_FILE!, true);
    const registry = new MessagingProviderRegistry([capturingProvider([])]);

    const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], {
      env, registry, resolveFollowupModel: async () => fakeFollowupModel(), selfLearnDistill: fakeDistill
    });

    expect(res.stdout).not.toContain("learned: +");
    expect(await readPendingLearnEvents(env.MUSE_LEARN_QUEUE_FILE!)).toHaveLength(1); // untouched, resume catches up
  });

  it("is OFF only on an explicit opt-out (MUSE_SELFLEARN_ENABLED=false) — the gate is real, the default is ON", async () => {
    const env: NodeJS.ProcessEnv = { ...tmpEnv(), MUSE_SELFLEARN_ENABLED: "false" };
    await seedCorrection(env);
    const registry = new MessagingProviderRegistry([capturingProvider([])]);

    const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], {
      env, registry, resolveFollowupModel: async () => fakeFollowupModel(), selfLearnDistill: fakeDistill
    });

    expect(res.stdout).not.toContain("learned: +");
    expect(await readPendingLearnEvents(env.MUSE_LEARN_QUEUE_FILE!)).toHaveLength(1);
  });

  it("--status uses the daemon's default-on self-learn gate and only an explicit false opts out", async () => {
    const registry = new MessagingProviderRegistry([capturingProvider([])]);

    const on = await runDaemon(["--status", "--provider", "telegram", "--destination", "555"], {
      env: { ...tmpEnv(), MUSE_SELFLEARN_ENABLED: "true" }, registry, resolveFollowupModel: async () => fakeFollowupModel()
    });
    expect(on.stdout).toContain("self-learn: enabled");

    const defaultOn = await runDaemon(["--status", "--provider", "telegram", "--destination", "555"], {
      env: tmpEnv(), registry, resolveFollowupModel: async () => fakeFollowupModel()
    });
    expect(defaultOn.stdout).toContain("self-learn: enabled");

    const off = await runDaemon(["--status", "--provider", "telegram", "--destination", "555"], {
      env: { ...tmpEnv(), MUSE_SELFLEARN_ENABLED: "false" }, registry, resolveFollowupModel: async () => fakeFollowupModel()
    });
    expect(off.stdout).toContain("self-learn: disabled");
  });
});

describe("muse daemon — autonomous playbook consolidate tick (sign-safe)", () => {
  const probationDup = (id: string, text: string): Parameters<typeof writePlaybook>[1][number] =>
    ({ createdAt: "2026-01-01T00:00:00Z", id, probation: true, text, userId: "u1" });
  // Deterministic merge + accept gate so the round-trip needs no live LLM/embedder.
  const fakeMerge: NonNullable<DaemonHelpers["consolidateMerge"]> = async () => "Monday standup is at 9:30am (consolidated).";
  const fakeAccept: NonNullable<DaemonHelpers["consolidateValidate"]> = async () => ({ accept: true, reason: "covers all originals" });
  const seedDup = async (env: NodeJS.ProcessEnv): Promise<void> => {
    // Near-duplicate PROBATION strategies (Jaccard ≥ the 0.6 clustering threshold).
    await writePlaybook(env.MUSE_PLAYBOOK_FILE!, [
      probationDup("p1", "Monday standup moved to nine thirty in the morning"),
      probationDup("p2", "Monday standup moved to nine thirty in the morning now")
    ]);
  };

  it("merges near-duplicate PROBATION strategies into ONE that STAYS on probation (never auto-graduates), removing the originals", async () => {
    const env = tmpEnv();
    env.MUSE_SELFLEARN_ENABLED = "true";
    await seedDup(env);
    const registry = new MessagingProviderRegistry([capturingProvider([])]);

    const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], {
      consolidateMerge: fakeMerge, consolidateValidate: fakeAccept, env, registry, resolveFollowupModel: async () => fakeFollowupModel()
    });

    expect(res.stdout).toMatch(/consolidate: merged 2 near-duplicate pending learning/);
    const after = await readPlaybook(env.MUSE_PLAYBOOK_FILE!);
    expect(after).toHaveLength(1); // 2 originals removed, 1 merged recorded
    expect(after[0]?.text).toBe("Monday standup is at 9:30am (consolidated).");
    expect(after[0]?.probation).toBe(true); // SAFETY: merged stays on probation — NO autonomous graduation
  });

  it("SAFETY: never touches GRADUATED (non-probation) strategies — only pending learnings are auto-consolidated", async () => {
    const env = tmpEnv();
    env.MUSE_SELFLEARN_ENABLED = "true";
    await writePlaybook(env.MUSE_PLAYBOOK_FILE!, [
      { createdAt: "2026-01-01T00:00:00Z", id: "g1", reward: 2, text: "Keep emails under four sentences.", userId: "u1" },
      { createdAt: "2026-01-01T00:00:00Z", id: "g2", reward: 2, text: "Keep every email to four sentences or fewer.", userId: "u1" }
    ]);
    const registry = new MessagingProviderRegistry([capturingProvider([])]);

    const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], {
      consolidateMerge: fakeMerge, consolidateValidate: fakeAccept, env, registry, resolveFollowupModel: async () => fakeFollowupModel()
    });

    expect(res.stdout).not.toContain("consolidate: merged");
    expect(await readPlaybook(env.MUSE_PLAYBOOK_FILE!)).toHaveLength(2); // graduated bank untouched
  });

  it("BRAKE: a paused learner freezes the bank — no autonomous consolidate", async () => {
    const env = tmpEnv();
    env.MUSE_SELFLEARN_ENABLED = "true";
    await seedDup(env);
    await setLearningPaused(env.MUSE_LEARNING_PAUSE_FILE!, true);
    const registry = new MessagingProviderRegistry([capturingProvider([])]);

    const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], {
      consolidateMerge: fakeMerge, consolidateValidate: fakeAccept, env, registry, resolveFollowupModel: async () => fakeFollowupModel()
    });

    expect(res.stdout).not.toContain("consolidate: merged");
    expect(await readPlaybook(env.MUSE_PLAYBOOK_FILE!)).toHaveLength(2); // untouched
  });

  it("held-out gate REJECTS a coverage-losing merge — originals are KEPT, nothing removed", async () => {
    const env = tmpEnv();
    env.MUSE_SELFLEARN_ENABLED = "true";
    await seedDup(env);
    const registry = new MessagingProviderRegistry([capturingProvider([])]);

    const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], {
      consolidateMerge: fakeMerge, consolidateValidate: async () => ({ accept: false, reason: "lost coverage" }), env, registry, resolveFollowupModel: async () => fakeFollowupModel()
    });

    expect(res.stdout).not.toContain("consolidate: merged");
    expect(await readPlaybook(env.MUSE_PLAYBOOK_FILE!)).toHaveLength(2); // rejected merge → originals kept
  });
});

describe("muse daemon — unattended disuse-decay tick", () => {
  // A positive-reward strategy not reinforced in 60 days — stale, eligible to fade.
  async function seedStaleStrategy(env: NodeJS.ProcessEnv, reward = 2): Promise<void> {
    const sixtyDaysAgo = new Date(Date.now() - 60 * 86_400_000).toISOString();
    await writePlaybook(env.MUSE_PLAYBOOK_FILE!, [{
      id: "p1", userId: "u1", text: "Prefer concise answers.",
      createdAt: sixtyDaysAgo, lastReinforcedAt: sixtyDaysAgo, reward, probation: false
    }]);
  }

  it("fades a stale, unused positive-reward strategy toward neutral AND tells you it's fading so you can rescue it", async () => {
    const env = tmpEnv();
    env.MUSE_SELFLEARN_ENABLED = "true";
    await seedStaleStrategy(env); // reward 2 → 1: crosses from healthy (>1) into near-forgotten (≤1)
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);

    const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], { env, registry });

    expect(res.stdout).toMatch(/decay: 1 stale strategy faded toward neutral/);
    expect((await readPlaybook(env.MUSE_PLAYBOOK_FILE!))[0]!.reward).toBe(1); // 2 → 1, one step toward neutral
    // FELT forgetting: the taught preference crossing into near-forgotten
    // is surfaced so the user can rescue it before it's gone.
    const fadeNotice = sent.find((m) => m.text.includes("is fading from disuse"));
    expect(fadeNotice, "a taught preference crossing into near-forgotten must be surfaced for rescue").toBeDefined();
    expect(fadeNotice!.text).toContain("Prefer concise answers.");
    expect(fadeNotice!.text).toContain("muse playbook reward");
  });

  it("does NOT cry 'fading' on a strategy that still has a healthy buffer (reward 3 → 2, stays >1)", async () => {
    const env = tmpEnv();
    env.MUSE_SELFLEARN_ENABLED = "true";
    await seedStaleStrategy(env, 3); // 3 → 2: still above the near-forgotten line, no nag
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);

    const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], { env, registry });

    expect(res.stdout).toMatch(/decay: 1 stale strategy faded toward neutral/);
    expect(sent.some((m) => m.text.includes("is fading from disuse"))).toBe(false);
  });

  it("BRAKE: a paused learner's bank is frozen — nothing decays", async () => {
    const env = tmpEnv();
    env.MUSE_SELFLEARN_ENABLED = "true";
    await seedStaleStrategy(env);
    await setLearningPaused(env.MUSE_LEARNING_PAUSE_FILE!, true);
    const registry = new MessagingProviderRegistry([capturingProvider([])]);

    const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], { env, registry });

    expect(res.stdout).not.toContain("decay:");
    expect((await readPlaybook(env.MUSE_PLAYBOOK_FILE!))[0]!.reward).toBe(2); // untouched, resume catches up
  });

  it("is OFF only on an explicit opt-out (same gate as distill)", async () => {
    const env: NodeJS.ProcessEnv = { ...tmpEnv(), MUSE_SELFLEARN_ENABLED: "false" };
    await seedStaleStrategy(env);
    const registry = new MessagingProviderRegistry([capturingProvider([])]);

    const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], { env, registry });

    expect(res.stdout).not.toContain("decay:");
    expect((await readPlaybook(env.MUSE_PLAYBOOK_FILE!))[0]!.reward).toBe(2);
  });
});

describe("muse daemon — continuous messaging poll tick (ingestion)", () => {
  it("with MUSE_MESSAGING_POLL_ENABLED the --once tick pulls new inbound (which the inbox cursor makes recallable) — no manual poll", async () => {
    const env: NodeJS.ProcessEnv = { ...tmpEnv(), MUSE_MESSAGING_POLL_ENABLED: "true" };
    const registry = new MessagingProviderRegistry([capturingProvider([])]);
    let polled = 0;
    const messagingPoll = async () => { polled += 1; return { errors: [], ingestedByProvider: { telegram: 2 } }; };
    const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], { env, messagingPoll, registry });
    expect(polled).toBe(1);
    expect(res.stdout).toMatch(/messaging-poll: \+2 new messages ingested/);
  });

  it("does NOTHING when MUSE_MESSAGING_POLL_ENABLED is unset (gate is real — off by default)", async () => {
    const registry = new MessagingProviderRegistry([capturingProvider([])]);
    let polled = 0;
    const messagingPoll = async () => { polled += 1; return { errors: [], ingestedByProvider: { telegram: 5 } }; };
    const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], { env: tmpEnv(), messagingPoll, registry });
    expect(polled).toBe(0);
    expect(res.stdout).not.toContain("messaging-poll:");
  });

  it("--status reports the messaging poll enabled only with the flag", async () => {
    const registry = new MessagingProviderRegistry([capturingProvider([])]);
    const on = await runDaemon(["--status", "--provider", "telegram", "--destination", "555"], { env: { ...tmpEnv(), MUSE_MESSAGING_POLL_ENABLED: "true" }, registry });
    expect(on.stdout).toContain("msg-poll:   enabled");
    const off = await runDaemon(["--status", "--provider", "telegram", "--destination", "555"], { env: tmpEnv(), registry });
    expect(off.stdout).toContain("msg-poll:   disabled");
  });
});

describe("muse daemon — continuous email-sync tick (always-on email→recall)", () => {
  const emailProvider = { listRecent: async () => [{ from: "Dana Wu <dana@example.com>", id: "m1", snippet: "can we move the Q3 review to Thursday?", subject: "Q3 budget review", unread: true }] };

  it("--once syncs recent emails into recallable notes when enabled (opt-in, no manual command)", async () => {
    const env = tmpEnv();
    env.MUSE_EMAIL_SYNC_ENABLED = "true";
    env.MUSE_NOTES_DIR = mkdtempSync(join(tmpdir(), "muse-daemon-email-"));
    const registry = new MessagingProviderRegistry([capturingProvider([])]);

    const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], { emailSyncProvider: emailProvider, env, registry });

    expect(res.stdout).toMatch(/email-sync: 1 email\(s\) → recall/);
    const note = readFileSync(join(env.MUSE_NOTES_DIR, "email", "m1.md"), "utf8");
    expect(note).toContain("Q3 budget review"); // subject → recallable
    expect(note).toContain("Dana Wu");          // from → "what did Dana email about?"
  });

  it("does NOTHING when MUSE_EMAIL_SYNC_ENABLED is unset (opt-in — off by default, no notes written)", async () => {
    const env = tmpEnv();
    env.MUSE_NOTES_DIR = mkdtempSync(join(tmpdir(), "muse-daemon-email-off-"));
    const registry = new MessagingProviderRegistry([capturingProvider([])]);

    const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], { emailSyncProvider: emailProvider, env, registry });

    expect(res.stdout).not.toContain("email-sync:");
    expect(existsSync(join(env.MUSE_NOTES_DIR, "email", "m1.md"))).toBe(false);
  });

  it("never constructs the Gmail sync factory under local-only, even with enabled poison credentials", async () => {
    const env = tmpEnv();
    env.MUSE_LOCAL_ONLY = "true";
    env.MUSE_EMAIL_SYNC_ENABLED = "true";
    Object.defineProperty(env, "MUSE_GMAIL_TOKEN", {
      configurable: true,
      enumerable: true,
      get: () => {
        throw new Error("Gmail token must not be read in local-only mode");
      }
    });
    const registry = new MessagingProviderRegistry([capturingProvider([])]);
    const makeEmailSyncTick = vi.fn(() => async () => ({ reason: "disabled" as const, status: "not-ready" as const }));

    const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], {
      env,
      makeEmailSyncTick,
      registry
    });

    expect(res.exitCode).toBeUndefined();
    expect(makeEmailSyncTick).not.toHaveBeenCalled();
  });

  it("does not let an injected false downgrade ambient local-only before the Gmail factory", async () => {
    const previous = process.env.MUSE_LOCAL_ONLY;
    process.env.MUSE_LOCAL_ONLY = "true";
    try {
      const env = tmpEnv();
      env.MUSE_LOCAL_ONLY = "false";
      env.MUSE_EMAIL_SYNC_ENABLED = "true";
      const registry = new MessagingProviderRegistry([capturingProvider([])]);
      const makeEmailSyncTick = vi.fn(() => async () => ({ reason: "disabled" as const, status: "not-ready" as const }));

      const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], {
        env,
        makeEmailSyncTick,
        registry
      });

      expect(res.exitCode).toBeUndefined();
      expect(makeEmailSyncTick).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.MUSE_LOCAL_ONLY;
      else process.env.MUSE_LOCAL_ONLY = previous;
    }
  });

  it("--status reports email-sync enabled when the gate + token are set", async () => {
    const registry = new MessagingProviderRegistry([capturingProvider([])]);
    const on = await runDaemon(["--status", "--provider", "telegram", "--destination", "555"], {
      env: { ...tmpEnv(), MUSE_EMAIL_SYNC_ENABLED: "true", MUSE_GMAIL_TOKEN: "tok" }, registry
    });
    expect(on.stdout).toContain("email-sync: enabled");
    const off = await runDaemon(["--status", "--provider", "telegram", "--destination", "555"], { env: tmpEnv(), registry });
    expect(off.stdout).toContain("email-sync: disabled");
  });
});

describe("muse daemon — conflict-watch tick proactively warns of upcoming double-bookings", () => {
  const overlappingEvents = () => {
    const base = Date.now() + 2 * 86_400_000; // 2 days out, inside the 7-day window
    return async () => [
      { title: "Design review", startsAt: new Date(base), endsAt: new Date(base + 60 * 60_000) },
      { title: "Dentist", startsAt: new Date(base + 30 * 60_000), endsAt: new Date(base + 90 * 60_000) }
    ];
  };

  it("enabled + an upcoming clash → ONE proactive warning naming both events", async () => {
    const env = { ...tmpEnv(), MUSE_CONFLICT_WATCH_ENABLED: "true", MUSE_CONFLICT_WATCH_SIDECAR_FILE: join(mkdtempSync(join(tmpdir(), "muse-cw-")), "fired.json") };
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);

    const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], { conflictWatchCalendarLister: overlappingEvents(), env, registry });

    expect(res.stdout).toContain("conflict-watch: warned of 1 upcoming double-booking");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.destination).toBe("555");
    expect(sent[0]!.text).toContain("conflict");
    expect(sent[0]!.text).toContain("Design review");
    expect(sent[0]!.text).toContain("Dentist");
  });

  it("dedup: the SAME clash is not re-warned on a later tick (key sidecar)", async () => {
    const env = { ...tmpEnv(), MUSE_CONFLICT_WATCH_ENABLED: "true", MUSE_CONFLICT_WATCH_SIDECAR_FILE: join(mkdtempSync(join(tmpdir(), "muse-cw-")), "fired.json") };
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);
    const lister = overlappingEvents();

    await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], { conflictWatchCalendarLister: lister, env, registry });
    const second = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], { conflictWatchCalendarLister: lister, env, registry });

    expect(sent).toHaveLength(1); // still just the first warning
    expect(second.stdout).not.toContain("conflict-watch: warned");
  });

  it("no clash → quiet (no send)", async () => {
    const env = { ...tmpEnv(), MUSE_CONFLICT_WATCH_ENABLED: "true", MUSE_CONFLICT_WATCH_SIDECAR_FILE: join(mkdtempSync(join(tmpdir(), "muse-cw-")), "fired.json") };
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);
    const base = Date.now() + 2 * 86_400_000;
    const apart = async () => [
      { title: "A", startsAt: new Date(base), endsAt: new Date(base + 30 * 60_000) },
      { title: "B", startsAt: new Date(base + 60 * 60_000), endsAt: new Date(base + 90 * 60_000) }
    ];

    const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], { conflictWatchCalendarLister: apart, env, registry });

    expect(res.stdout).not.toContain("conflict-watch: warned");
    expect(sent).toHaveLength(0);
  });

  it("disabled by default → no warning even with a clash present", async () => {
    const env = { ...tmpEnv(), MUSE_CONFLICT_WATCH_SIDECAR_FILE: join(mkdtempSync(join(tmpdir(), "muse-cw-")), "fired.json") };
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);

    const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], { conflictWatchCalendarLister: overlappingEvents(), env, registry });

    expect(res.stdout).not.toContain("conflict-watch:");
    expect(sent).toHaveLength(0);
  });

  it("--status reports conflict-watch enabled/disabled for discoverability", async () => {
    const registry = new MessagingProviderRegistry([capturingProvider([])]);
    const on = await runDaemon(["--status", "--provider", "telegram", "--destination", "555"], {
      env: { ...tmpEnv(), MUSE_CONFLICT_WATCH_ENABLED: "true" }, registry
    });
    expect(on.stdout).toContain("conflicts:  enabled");
    const off = await runDaemon(["--status", "--provider", "telegram", "--destination", "555"], { env: tmpEnv(), registry });
    expect(off.stdout).toContain("conflicts:  disabled — conflict-watch warns you ahead of upcoming double-bookings — set MUSE_CONFLICT_WATCH_ENABLED to turn it on");
  });
});

// Browsing auto-sync (stage 3a) — the opt-in daemon half of `muse browsing sync`.
// The consent contract is identity-critical: OFF by default performs ZERO Chrome
// access; the env var being set IS the standing consent.
describe("muse daemon — opt-in browsing auto-sync tick", () => {
  interface SeedRow { readonly id: number; readonly url: string; readonly title: string | null; readonly visitTime: number }
  function buildHistoryDb(file: string, rows: readonly SeedRow[]): void {
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE IF NOT EXISTS urls(id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER)");
    db.exec("CREATE TABLE IF NOT EXISTS visits(id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER)");
    const insertUrl = db.prepare("INSERT INTO urls(id, url, title, visit_count) VALUES(?, ?, ?, 1)");
    const insertVisit = db.prepare("INSERT INTO visits(id, url, visit_time) VALUES(?, ?, ?)");
    for (const row of rows) { insertUrl.run(row.id, row.url, row.title); insertVisit.run(row.id, row.id, BigInt(row.visitTime)); }
    db.close();
  }
  const HISTORY_CURSOR = 13_390_000_000_000_000;
  function seedHistory(dir: string): string {
    const file = join(dir, "History");
    buildHistoryDb(file, [
      { id: 1, url: "https://blog.example/rust", title: "Rust guide", visitTime: HISTORY_CURSOR + 2_000_000 },
      { id: 2, url: "https://news.example/ai", title: "AI news", visitTime: HISTORY_CURSOR + 4_000_000 }
    ]);
    return file;
  }

  // THE CONSENT PIN: absent gate ⇒ the sync path (the ONLY code that locates +
  // reads the Chrome file) is never entered, so the archive is never written —
  // provably identical to today's "no daemon touches Chrome" contract.
  it("default (gate absent): performs ZERO Chrome access — no sync, no archive written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-browsing-off-"));
    const historyFile = seedHistory(dir);
    const storeFile = join(dir, "browsing.json");
    const env: NodeJS.ProcessEnv = { ...tmpEnv(), MUSE_CHROME_HISTORY_FILE: historyFile, MUSE_BROWSING_FILE: storeFile };
    writeFileSync(env.MUSE_TASKS_FILE!, JSON.stringify({ tasks: [] }), "utf8");
    const registry = new MessagingProviderRegistry([capturingProvider([])]);

    const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], { env, registry });

    expect(res.exitCode).toBeUndefined();
    expect(res.stdout).not.toContain("browsing:");
    // The sync writes the archive; its absence proves the Chrome file was never read.
    expect(existsSync(storeFile)).toBe(false);
  });

  it("gate explicitly false: the sync seam is NEVER called (spy proves the path is not entered)", async () => {
    const env: NodeJS.ProcessEnv = { ...tmpEnv(), MUSE_BROWSING_AUTO_SYNC: "false" };
    writeFileSync(env.MUSE_TASKS_FILE!, JSON.stringify({ tasks: [] }), "utf8");
    const registry = new MessagingProviderRegistry([capturingProvider([])]);
    let calls = 0;
    const browsingSync = async (): Promise<{ synced: number; total: number }> => { calls += 1; return { synced: 0, total: 0 }; };

    const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], { browsingSync, env, registry });

    expect(res.exitCode).toBeUndefined();
    expect(calls).toBe(0);
    expect(res.stdout).not.toContain("browsing:");
  });

  it("opted in (gate true): syncs new Chrome visits into the local archive end-to-end", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-browsing-on-"));
    const historyFile = seedHistory(dir);
    const storeFile = join(dir, "browsing.json");
    const env: NodeJS.ProcessEnv = { ...tmpEnv(), MUSE_BROWSING_AUTO_SYNC: "true", MUSE_CHROME_HISTORY_FILE: historyFile, MUSE_BROWSING_FILE: storeFile };
    writeFileSync(env.MUSE_TASKS_FILE!, JSON.stringify({ tasks: [] }), "utf8");
    const registry = new MessagingProviderRegistry([capturingProvider([])]);

    const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], { env, registry });

    expect(res.exitCode).toBeUndefined();
    expect(res.stdout).toMatch(/browsing: synced 2 new visits/);
    const store = await readBrowsingStore(storeFile);
    expect(store.visits.map((v) => v.url).sort()).toEqual(["https://blog.example/rust", "https://news.example/ai"]);
  });

  it("fail-soft: a missing Chrome file yields a quiet, non-throwing tick — daemon stays up", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-browsing-missing-"));
    const env: NodeJS.ProcessEnv = { ...tmpEnv(), MUSE_BROWSING_AUTO_SYNC: "true", MUSE_CHROME_HISTORY_FILE: join(dir, "does-not-exist") };
    writeFileSync(env.MUSE_TASKS_FILE!, JSON.stringify({ tasks: [] }), "utf8");
    const registry = new MessagingProviderRegistry([capturingProvider([])]);

    const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], { env, registry });

    expect(res.exitCode).toBeUndefined();
    expect(res.stdout).toContain("daemon --once complete");
    expect(res.stdout).not.toContain("browsing: synced");
  });

  it("--status reports browsing auto-sync enabled/disabled for discoverability", async () => {
    const registry = new MessagingProviderRegistry([capturingProvider([])]);
    const on = await runDaemon(["--status", "--provider", "telegram", "--destination", "555"], {
      env: { ...tmpEnv(), MUSE_BROWSING_AUTO_SYNC: "true" }, registry
    });
    expect(on.stdout).toContain("browsing:   enabled");
    const off = await runDaemon(["--status", "--provider", "telegram", "--destination", "555"], { env: tmpEnv(), registry });
    expect(off.stdout).toContain("browsing:   disabled — browsing-sync pulls your Chrome history into recall so Muse can reference pages you've viewed — set MUSE_BROWSING_AUTO_SYNC to turn it on");
  });
});

describe("muse daemon — daily digest flush (delivery half of the interruption budget)", () => {
  it("at the digest hour: flushes the pre-seeded queue through the SAME channel as proactive, and drains it", async () => {
    const env = tmpEnv();
    // Deterministic without an injectable clock: pin the digest hour to
    // whatever the real local hour is right now, so the tick's own
    // `now.getHours() === digestHour` check passes regardless of when this
    // suite runs.
    env.MUSE_DIGEST_HOUR = new Date().getHours().toString();
    await appendDigestItem(env.MUSE_DIGEST_QUEUE_FILE!, {
      at: new Date(Date.now() - 60_000),
      source: "pattern-firing",
      text: "you usually leave by 5pm"
    });
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);

    const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], { env, registry });

    expect(res.exitCode).toBeUndefined();
    expect(res.stdout).toMatch(/digest: sent \(1 item\(s\)\)/);
    const digestSend = sent.find((m) => m.text.includes("you usually leave by 5pm"));
    expect(digestSend).toBeDefined();
    expect(digestSend!.destination).toBe("555");
    expect(await readDigestQueue(env.MUSE_DIGEST_QUEUE_FILE!)).toHaveLength(0);
  });

  it("MUSE_DIGEST_ENABLED=false: the queue is never flushed even at the digest hour", async () => {
    const env = tmpEnv();
    env.MUSE_DIGEST_HOUR = new Date().getHours().toString();
    env.MUSE_DIGEST_ENABLED = "false";
    await appendDigestItem(env.MUSE_DIGEST_QUEUE_FILE!, { at: new Date(), source: "pattern-firing", text: "should stay queued" });
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);

    const res = await runDaemon(["--once", "--provider", "telegram", "--destination", "555"], { env, registry });

    expect(res.exitCode).toBeUndefined();
    expect(res.stdout).not.toContain("digest:");
    expect(sent.some((m) => m.text.includes("should stay queued"))).toBe(false);
    expect(await readDigestQueue(env.MUSE_DIGEST_QUEUE_FILE!)).toHaveLength(1);
  });

  it("--status reports the digest daemon's default-on state and its configured hour", async () => {
    const registry = new MessagingProviderRegistry([capturingProvider([])]);
    const res = await runDaemon(["--status", "--provider", "telegram", "--destination", "555"], { env: tmpEnv(), registry });
    expect(res.stdout).toContain("digest:     enabled (daily, at 18:00 local)");
  });

  describe("day rhythm (하루 리듬) — digest auto-routing", () => {
    it("day rhythm on: flushes at dayRhythm.eveningHour and auto-routes to the paired channel when provider is still 'log'", async () => {
      const env = tmpEnv();
      const currentHour = new Date().getHours();
      await appendDigestItem(env.MUSE_DIGEST_QUEUE_FILE!, {
        at: new Date(Date.now() - 60_000),
        source: "pattern-firing",
        text: "day-rhythm queued item"
      });
      writeFileSync(env.MUSE_CHANNEL_OWNERS_FILE!, JSON.stringify({ owners: { telegram: "555" }, version: 1 }), "utf8");
      await writeDayRhythmConfig(env.MUSE_CLI_CONFIG_FILE!, { enabled: true, eveningHour: currentHour, morningHour: 8 });
      const sent: OutboundMessage[] = [];
      const registry = new MessagingProviderRegistry([capturingProvider(sent), new LogMessagingProvider()]);

      // NO --provider/--destination flags and no MUSE_DIGEST_HOUR — both come from day rhythm.
      const res = await runDaemon(["--once"], { env, registry });

      expect(res.exitCode).toBeUndefined();
      expect(res.stdout).toMatch(/digest: sent \(1 item\(s\)\)/);
      const digestSend = sent.find((m) => m.text.includes("day-rhythm queued item"));
      expect(digestSend).toBeDefined();
      expect(digestSend!.destination).toBe("555");
      expect(await readDigestQueue(env.MUSE_DIGEST_QUEUE_FILE!)).toHaveLength(0);
    });

    it("day rhythm on: no paired channel → an honest skip, the queue is preserved (fail-close)", async () => {
      const env = tmpEnv();
      const currentHour = new Date().getHours();
      await appendDigestItem(env.MUSE_DIGEST_QUEUE_FILE!, { at: new Date(), source: "pattern-firing", text: "should stay queued (unpaired)" });
      await writeDayRhythmConfig(env.MUSE_CLI_CONFIG_FILE!, { enabled: true, eveningHour: currentHour, morningHour: 8 });
      const sent: OutboundMessage[] = [];
      const registry = new MessagingProviderRegistry([capturingProvider(sent), new LogMessagingProvider()]);

      const res = await runDaemon(["--once"], { env, registry });

      expect(res.exitCode).toBeUndefined();
      expect(res.stdout).toMatch(/digest: day rhythm on but no channel paired/);
      expect(sent).toHaveLength(0);
      expect(await readDigestQueue(env.MUSE_DIGEST_QUEUE_FILE!)).toHaveLength(1);
    });

    it("an explicit MUSE_DIGEST_HOUR still wins over dayRhythm.eveningHour (env overrides config)", async () => {
      const env = tmpEnv();
      const currentHour = new Date().getHours();
      const farEveningHour = (currentHour + 6) % 24;
      env.MUSE_DIGEST_HOUR = currentHour.toString();
      await appendDigestItem(env.MUSE_DIGEST_QUEUE_FILE!, { at: new Date(Date.now() - 60_000), source: "pattern-firing", text: "explicit-hour item" });
      writeFileSync(env.MUSE_CHANNEL_OWNERS_FILE!, JSON.stringify({ owners: { telegram: "555" }, version: 1 }), "utf8");
      // dayRhythm's eveningHour is deliberately FAR from now — if it (wrongly)
      // won over the explicit env var, the flush would not fire this tick.
      await writeDayRhythmConfig(env.MUSE_CLI_CONFIG_FILE!, { enabled: true, eveningHour: farEveningHour, morningHour: 8 });
      const sent: OutboundMessage[] = [];
      const registry = new MessagingProviderRegistry([capturingProvider(sent), new LogMessagingProvider()]);

      const res = await runDaemon(["--once"], { env, registry });

      expect(res.exitCode).toBeUndefined();
      expect(res.stdout).toMatch(/digest: sent \(1 item\(s\)\)/);
    });
  });
});
