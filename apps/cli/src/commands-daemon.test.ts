import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessagingProviderRegistry, type MessagingProvider, type OutboundMessage, type OutboundReceipt } from "@muse/messaging";
import { writeFollowups, writeObjectives } from "@muse/mcp";
import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { buildLaunchAgentPlist, DaemonStopSignal, registerDaemonCommands, runDaemonLoop, type DaemonHelpers } from "./commands-daemon.js";

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
  opts: { env: NodeJS.ProcessEnv; registry: MessagingProviderRegistry; resolveFollowupModel?: DaemonHelpers["resolveFollowupModel"]; fetchImpl?: typeof globalThis.fetch; ambientMacosRun?: DaemonHelpers["ambientMacosRun"]; chromeConnection?: DaemonHelpers["chromeConnection"] }
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
    MUSE_DAEMON_CONFIG_FILE: join(dir, "daemon.json"),
    MUSE_FOLLOWUPS_FILE: join(dir, "followups.json"),
    MUSE_OBJECTIVES_FILE: join(dir, "objectives.json"),
    MUSE_PROACTIVE_HISTORY_FILE: join(dir, "history.json"),
    MUSE_PROACTIVE_SIDECAR_FILE: join(dir, "fired.json"),
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
