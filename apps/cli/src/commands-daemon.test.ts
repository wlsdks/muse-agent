import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessagingProviderRegistry, type MessagingProvider, type OutboundMessage, type OutboundReceipt } from "@muse/messaging";
import { buildCheckinQuestion, readProposedActions, readReflections, writeCheckins, writeEpisodes, writeFollowups, writeObjectives, type PersistedCheckin, type PersistedEpisode } from "@muse/mcp";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MuseTool } from "@muse/tools";

import { buildLaunchAgentPlist, chromeSnapshotConnectionFromTools, DaemonStopSignal, registerDaemonCommands, runDaemonLoop, type DaemonHelpers } from "./commands-daemon.js";

function fakeChromeTools(snapshotText: string): MuseTool[] {
  const mk = (name: string, result: string): MuseTool => ({
    definition: { description: "", inputSchema: {}, name: `chrome-devtools.${name}`, risk: "read" },
    execute: async () => result
  } as unknown as MuseTool);
  return [mk("navigate_page", "ok"), mk("take_snapshot", snapshotText)];
}

function capturingProvider(sent: OutboundMessage[]): MessagingProvider {
  return {
    describe: () => ({ description: "t", displayName: "T", id: "telegram" }),
    id: "telegram",
    async send(message: OutboundMessage): Promise<OutboundReceipt> {
      sent.push(message);
      return { destination: message.destination, messageId: "m1", providerId: "telegram" };
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
  opts: { env: NodeJS.ProcessEnv; registry: MessagingProviderRegistry; resolveFollowupModel?: DaemonHelpers["resolveFollowupModel"]; fetchImpl?: typeof globalThis.fetch; ambientMacosRun?: DaemonHelpers["ambientMacosRun"]; chromeConnection?: DaemonHelpers["chromeConnection"]; knowledgeEnrich?: DaemonHelpers["knowledgeEnrich"]; briefingCalendarLister?: DaemonHelpers["briefingCalendarLister"] }
): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io = { stderr: (m: string) => stderr.push(m), stdout: (m: string) => stdout.push(m) };
  const prevExit = process.exitCode;
  let exitCode: number | undefined;
  try {
    const program = new Command();
    program.exitOverride();
    registerDaemonCommands(program, io, {
      buildMessagingRegistry: () => opts.registry,
      env: () => opts.env,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.ambientMacosRun ? { ambientMacosRun: opts.ambientMacosRun } : {}),
      ...(opts.chromeConnection ? { chromeConnection: opts.chromeConnection } : {}),
      ...(opts.knowledgeEnrich ? { knowledgeEnrich: opts.knowledgeEnrich } : {}),
      ...(opts.briefingCalendarLister ? { briefingCalendarLister: opts.briefingCalendarLister } : {}),
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
    MUSE_AMBIENT_FILE: join(dir, "ambient.json"),
    MUSE_BRIEFING_SIDECAR_FILE: join(dir, "briefing-fired.json"),
    MUSE_CONTACTS_FILE: join(dir, "contacts.json"),
    MUSE_DAEMON_CONFIG_FILE: join(dir, "daemon.json"),
    MUSE_FOLLOWUPS_FILE: join(dir, "followups.json"),
    MUSE_OBJECTIVES_FILE: join(dir, "objectives.json"),
    MUSE_PROACTIVE_HISTORY_FILE: join(dir, "history.json"),
    MUSE_PROACTIVE_SIDECAR_FILE: join(dir, "fired.json"),
    MUSE_PROPOSED_ACTIONS_FILE: join(dir, "proposed.json"),
    MUSE_REMINDERS_FILE: join(dir, "reminders.json"),
    MUSE_TASKS_FILE: join(dir, "tasks.json")
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
    const env = tmpEnv();
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
    writeFileSync(env.MUSE_TASKS_FILE!, JSON.stringify({ tasks: [] }), "utf8");
    await writeObjectives(env.MUSE_OBJECTIVES_FILE!, [
      { attempts: 0, createdAt: "2026-01-01T00:00:00Z", id: "obj1", kind: "watch", spec: "ping me when the build is green", status: "active", userId: "stark" }
    ]);
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);
    const metModel: DaemonHelpers["resolveFollowupModel"] = async () => ({
      model: "test-model",
      modelProvider: { generate: async () => ({ output: '{"outcome":"met"}' }) } as never
    });

    const res = await runDaemon(
      ["--once", "--provider", "telegram", "--destination", "555"],
      { env, registry, resolveFollowupModel: metModel }
    );

    expect(res.exitCode).toBeUndefined();
    expect(res.stdout).toMatch(/objectives: 1 fired/);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("Objective met: ping me when the build is green");
  });

  it("--once with MUSE_OBJECTIVES_PROPOSE proposes a met objective instead of sending it", async () => {
    const env: NodeJS.ProcessEnv = { ...tmpEnv(), MUSE_OBJECTIVES_PROPOSE: "true" };
    writeFileSync(env.MUSE_TASKS_FILE!, JSON.stringify({ tasks: [] }), "utf8");
    await writeObjectives(env.MUSE_OBJECTIVES_FILE!, [
      { attempts: 0, createdAt: "2026-01-01T00:00:00Z", id: "obj1", kind: "watch", spec: "ping me when the build is green", status: "active", userId: "stark" }
    ]);
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);
    const metModel: DaemonHelpers["resolveFollowupModel"] = async () => ({
      model: "test-model",
      modelProvider: { generate: async () => ({ output: '{"outcome":"met"}' }) } as never
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

  it("--status reports launchd autostart state (installed vs not)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-autostart-"));
    const plistFile = join(dir, "com.muse.daemon.plist");
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);

    const notInstalled = await runDaemon(
      ["--status", "--provider", "telegram", "--destination", "555"],
      { env: { ...tmpEnv(), MUSE_DAEMON_PLIST_FILE: plistFile }, registry }
    );
    expect(notInstalled.stdout).toMatch(/autostart:\s+not installed/);

    writeFileSync(plistFile, "<plist/>", "utf8");
    const installed = await runDaemon(
      ["--status", "--provider", "telegram", "--destination", "555"],
      { env: { ...tmpEnv(), MUSE_DAEMON_PLIST_FILE: plistFile }, registry }
    );
    expect(installed.stdout).toMatch(/autostart:\s+installed/);
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
    // verdict (JSON) — branch on the evaluator prompt's "outcome" token.
    const smartModel: DaemonHelpers["resolveFollowupModel"] = async () => ({
      model: "test-model",
      modelProvider: { generate: async (req: { messages?: unknown }) => {
        const blob = JSON.stringify(req.messages ?? "");
        return blob.includes("outcome") ? { output: '{"outcome":"met"}' } : { output: "Quick follow-up on the memo." };
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

  it("--install writes a valid LaunchAgent plist at the configured path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-install-"));
    const plistFile = join(dir, "com.muse.daemon.plist");
    const env: NodeJS.ProcessEnv = { ...tmpEnv(), MUSE_DAEMON_PLIST_FILE: plistFile };
    const sent: OutboundMessage[] = [];
    const registry = new MessagingProviderRegistry([capturingProvider(sent)]);

    const res = await runDaemon(["--install", "--provider", "telegram", "--destination", "555"], { env, registry });

    expect(res.exitCode).toBeUndefined();
    expect(res.stdout).toContain("LaunchAgent written");
    expect(res.stdout).toContain("launchctl load -w");
    expect(existsSync(plistFile)).toBe(true);
    expect(sent).toHaveLength(0);
    if (process.platform === "darwin") {
      expect(() => execFileSync("plutil", ["-lint", plistFile], { encoding: "utf8" })).not.toThrow();
    }
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
    signal.stop();
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
    expect(xml).toContain("<string>daemon</string>");
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
function fakeReflectionModel(): NonNullable<Awaited<ReturnType<NonNullable<DaemonHelpers["resolveFollowupModel"]>>>> {
  return {
    model: "test-model",
    modelProvider: { generate: async () => ({ output: '[{"insight":"You troubleshoot home networking often","sources":["e1","e2","e3"]}]' }) } as never
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

describe("muse daemon — grounded dreaming tick (P32-3)", () => {
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
