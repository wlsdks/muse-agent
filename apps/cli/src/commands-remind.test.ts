import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { registerRemindCommands, type RemindCommandHelpers } from "./commands-remind.js";

interface ApiCall {
  readonly path: string;
  readonly body?: Record<string, unknown>;
  readonly method?: string;
}

async function runRemind(args: string[]): Promise<{
  readonly error?: string;
  readonly apiCalls: readonly ApiCall[];
  readonly stdout: string;
}> {
  const stdout: string[] = [];
  const apiCalls: ApiCall[] = [];
  const io = { stderr: () => {}, stdout: (m: string) => stdout.push(m) };
  const helpers: RemindCommandHelpers = {
    apiRequest: async (_io, _command, path, body, method) => {
      apiCalls.push({ body, method, path });
      return { dueAt: String(body?.dueAt ?? ""), id: "rem_remote", text: String(body?.text ?? "") };
    },
    writeOutput: (wio, value) => wio.stdout(`${JSON.stringify(value)}\n`)
  };
  let error: string | undefined;
  try {
    const program = new Command();
    program.exitOverride();
    registerRemindCommands(program, io, helpers);
    await program.parseAsync(["node", "muse", "remind", ...args]);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  return { apiCalls, error, stdout: stdout.join("") };
}

describe("muse remind add — pre-dispatch <when> validation", () => {
  it("remote mode rejects an invalid <when> with the actionable error BEFORE any API call", async () => {
    const r = await runRemind(["blah-not-a-time", "buy", "milk"]);
    expect(r.error).toBeDefined();
    expect(r.error).toContain("ISO-8601");
    expect(r.error).toContain("relative phrase");
    // The whole point: no wasted round-trip on input the server
    // (same parseReminderDueAt grammar) would only reject anyway.
    expect(r.apiCalls).toHaveLength(0);
  });

  it("remote mode still sends a VALID <when> raw to the API (server stays the resolution authority)", async () => {
    const r = await runRemind(["in 3 hours", "stand", "up"]);
    expect(r.error).toBeUndefined();
    expect(r.apiCalls).toHaveLength(1);
    expect(r.apiCalls[0]!.path).toBe("/api/reminders");
    expect(r.apiCalls[0]!.body).toMatchObject({ dueAt: "in 3 hours", text: "stand up" });
  });

  it("local mode keeps rejecting an invalid <when> with the same actionable error", async () => {
    const r = await runRemind(["--local", "still-not-a-time", "do", "thing"]);
    expect(r.error).toBeDefined();
    expect(r.error).toContain("relative phrase");
    expect(r.apiCalls).toHaveLength(0);
  });
});
