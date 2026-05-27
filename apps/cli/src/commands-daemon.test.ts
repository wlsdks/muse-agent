import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { MessagingProviderRegistry, type MessagingProvider, type OutboundMessage, type OutboundReceipt } from "@muse/messaging";
import { describe, expect, it } from "vitest";

import { registerDaemonCommands } from "./commands-daemon.js";

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

async function runDaemon(
  args: string[],
  opts: { env: NodeJS.ProcessEnv; registry: MessagingProviderRegistry }
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
      env: () => opts.env
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
    MUSE_PROACTIVE_HISTORY_FILE: join(dir, "history.json"),
    MUSE_PROACTIVE_SIDECAR_FILE: join(dir, "fired.json"),
    MUSE_TASKS_FILE: join(dir, "tasks.json")
  };
}

describe("muse daemon — one-process launcher fires a real proactive tick", () => {
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
