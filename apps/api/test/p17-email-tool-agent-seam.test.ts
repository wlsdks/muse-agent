import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentRuntime } from "@muse/agent-core";
import { GmailEmailProvider, createEmailSendTool, type EmailApprovalGate } from "@muse/domain-tools";
import type { ModelProvider, ModelResponse } from "@muse/model";
import type { Contact } from "@muse/stores";
import { ToolRegistry } from "@muse/tools";
import { describe, expect, it } from "vitest";

// P17 seam: the AGENT invokes the gated email_send actuator inside a
// real `createAgentRuntime` run — the model emits an email_send
// tool-call, the runtime executes it, and the SAME fail-closed
// `sendEmailWithApproval` gate decides. Confirm ⇒ the real Gmail send
// fires (HTTP faked, recorded); deny / ambiguous ⇒ NO external effect.

function sequenceProvider(responses: readonly ModelResponse[]): ModelProvider {
  let index = 0;
  return {
    id: "test",
    async generate(request) {
      const response = responses[Math.min(index, responses.length - 1)]!;
      index += 1;
      return { ...response, model: request.model };
    },
    async listModels() { return []; },
    async *stream() { /* unused */ }
  } as unknown as ModelProvider;
}

function gmail(): { sender: GmailEmailProvider; sends: { url: string; bearer: boolean }[] } {
  const sends: { url: string; bearer: boolean }[] = [];
  const fetchImpl = (async (url: string | URL, init?: { headers?: Record<string, string> }) => {
    sends.push({ bearer: (init?.headers?.authorization ?? "").startsWith("Bearer "), url: String(url) });
    return new Response(JSON.stringify({ id: "sent" }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { sender: new GmailEmailProvider("tok", fetchImpl), sends };
}

const approve: EmailApprovalGate = () => ({ approved: true });
const deny: EmailApprovalGate = () => ({ approved: false, reason: "user declined" });

function logFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-p17-")), "action-log.json");
}

function runtimeWith(tool: ReturnType<typeof createEmailSendTool>, args: Record<string, unknown>) {
  return createAgentRuntime({
    maxToolCalls: 1,
    modelProvider: sequenceProvider([
      { id: "tool", model: "m", output: "Sending.", toolCalls: [{ arguments: args, id: "tc-1", name: "email_send" }] },
      { id: "final", model: "m", output: "Done." }
    ]),
    toolRegistry: new ToolRegistry([tool])
  });
}

const SOLO: Contact[] = [{ email: "bob@example.com", id: "c_b", name: "Bob" }];
const TWO_BOBS: Contact[] = [{ email: "b1@x.com", id: "c1", name: "Bob" }, { email: "b2@x.com", id: "c2", name: "Bob" }];

describe("P17 seam — the agent invokes the gated email_send tool", () => {
  it("CONFIRM: an agent run calls email_send and the real Gmail send fires once", async () => {
    const { sender, sends } = gmail();
    const tool = createEmailSendTool({ actionLogFile: logFile(), approvalGate: approve, contacts: () => SOLO, sender, userId: "stark" });
    await runtimeWith(tool, { body: "the Q3 summary", subject: "Q3", to: "Bob" })
      .run({ messages: [{ content: "email Bob the Q3 summary", role: "user" }], metadata: { localMode: true }, model: "provider/model" });
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ bearer: true });
    expect(sends[0]!.url).toContain("/messages/send");
  });

  it("DENY: the agent calls email_send but the fail-closed gate blocks it — NO send", async () => {
    const { sender, sends } = gmail();
    const tool = createEmailSendTool({ actionLogFile: logFile(), approvalGate: deny, contacts: () => SOLO, sender, userId: "stark" });
    await runtimeWith(tool, { body: "hi", subject: "Q3", to: "Bob" })
      .run({ messages: [{ content: "email Bob", role: "user" }], metadata: { localMode: true }, model: "provider/model" });
    expect(sends).toHaveLength(0);
  });

  it("AMBIGUOUS recipient: NO send even with an approving gate (never-guess via the agent path)", async () => {
    const { sender, sends } = gmail();
    const tool = createEmailSendTool({ actionLogFile: logFile(), approvalGate: approve, contacts: () => TWO_BOBS, sender, userId: "stark" });
    await runtimeWith(tool, { body: "hi", subject: "Q3", to: "Bob" })
      .run({ messages: [{ content: "email Bob", role: "user" }], metadata: { localMode: true }, model: "provider/model" });
    expect(sends).toHaveLength(0);
  });
});
