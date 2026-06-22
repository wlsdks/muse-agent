import { readActionLog } from "@muse/stores";
import { Command } from "commander";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { registerMessagingCommands, type MessagingSendDeps } from "./commands-messaging.js";
import type { ProgramIO } from "./program.js";

/**
 * `muse messaging send --local` must be draft-first + fail-closed + action-logged
 * like `muse email send` — a denied/erroring gate produces NO external send
 * (outbound-safety.md). These run the REAL CLI action over a fake registry +
 * injected gate, asserting the send never reaches the provider when refused.
 */
function harness(deps: MessagingSendDeps) {
  const out: string[] = [];
  const err: string[] = [];
  const io = { stderr: (m: string) => err.push(m), stdout: (m: string) => out.push(m) } as unknown as ProgramIO;
  const program = new Command();
  program.exitOverride();
  registerMessagingCommands(
    program,
    io,
    { apiRequest: async () => ({}), writeOutput: (_io, v) => out.push(JSON.stringify(v)) },
    deps
  );
  return { err, out, program };
}

function recordingRegistry() {
  const sent: Array<{ providerId: string; destination: string; text: string }> = [];
  const registry = {
    send: async (providerId: string, m: { destination: string; text: string }) => {
      sent.push({ destination: m.destination, providerId, text: m.text });
      return { destination: m.destination, messageId: "msg_1", providerId };
    }
  };
  return { registry, sent };
}

const logFile = (): string => join(mkdtempSync(join(tmpdir(), "muse-msg-send-")), "actions.jsonl");

describe("muse messaging send --local — outbound-safety gate", () => {
  it("a DENIED gate sends NOTHING and records a refusal in the action log", async () => {
    const { registry, sent } = recordingRegistry();
    const actionLogFile = logFile();
    const { err, program } = harness({ actionLogFile, approvalGate: () => ({ approved: false, reason: "user did not confirm" }), registry });
    process.exitCode = 0;
    await program.parseAsync(["node", "muse", "messaging", "send", "--local", "telegram", "chat123", "secret", "plans"]);
    expect(sent).toHaveLength(0); // NOTHING left the process
    expect(err.join("")).toContain("Not sent (denied)");
    expect(process.exitCode).toBe(1);
    const log = await readActionLog(actionLogFile);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ result: "refused", what: "message via telegram to chat123" });
    process.exitCode = 0;
  });

  it("a gate that THROWS is treated as a denial — still no send (fail-closed)", async () => {
    const { registry, sent } = recordingRegistry();
    const actionLogFile = logFile();
    const { err, program } = harness({ actionLogFile, approvalGate: () => { throw new Error("approval channel down"); }, registry });
    process.exitCode = 0;
    await program.parseAsync(["node", "muse", "messaging", "send", "--local", "telegram", "chat123", "hi"]);
    expect(sent).toHaveLength(0);
    expect(err.join("")).toContain("Not sent (denied)");
    process.exitCode = 0;
  });

  it("an APPROVED gate sends the exact draft and records a performed entry", async () => {
    const { registry, sent } = recordingRegistry();
    const actionLogFile = logFile();
    const { out, program } = harness({ actionLogFile, approvalGate: () => ({ approved: true }), registry });
    await program.parseAsync(["node", "muse", "messaging", "send", "--local", "discord", "chan-9", "hello", "world"]);
    expect(sent).toEqual([{ destination: "chan-9", providerId: "discord", text: "hello world" }]);
    expect(out.join("")).toContain("Sent discord → chan-9");
    const log = await readActionLog(actionLogFile);
    expect(log[0]).toMatchObject({ result: "performed" });
  });
});
