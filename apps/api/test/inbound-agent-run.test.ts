import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { UNGROUNDABLE_ANSWER_NOTICE } from "@muse/agent-core";
import { LogMessagingProvider, MessagingProviderRegistry } from "@muse/messaging";
import { describe, expect, it } from "vitest";

import { createInboundAgentRun } from "../src/inbound-agent-run.js";

// The channel reply surface (Telegram et al.) answers with the FULL agent, so
// its output must pass the SAME deterministic grounding + citation gate the
// API /chat and CLI chat surfaces apply: a citation naming a source the run
// never produced is dropped BY CODE before the reply leaves for the channel,
// and a properly grounded answer passes through byte-identical.

const NOW = () => new Date("2026-07-11T09:00:00.000Z");

function buildRun(result: {
  readonly output: string;
  readonly groundingSources?: readonly { readonly source: string; readonly text: string }[];
}) {
  const dir = mkdtempSync(join(tmpdir(), "muse-inbound-gate-"));
  const registry = new MessagingProviderRegistry([
    new LogMessagingProvider({ file: join(dir, "notice.log"), id: "log", now: NOW })
  ]);
  const agentRuntime = {
    run: async () => ({
      response: { output: result.output },
      ...(result.groundingSources ? { groundingSources: result.groundingSources } : {})
    })
  };
  const env = {
    MUSE_ACTION_LOG_FILE: join(dir, "action-log.json"),
    MUSE_CONTACTS_FILE: join(dir, "contacts.json"),
    MUSE_PENDING_APPROVALS_FILE: join(dir, "pending.json")
  };
  return createInboundAgentRun({ agentRuntime, env, model: "default", registry });
}

describe("createInboundAgentRun grounding gate (channel-reply parity with /chat)", () => {
  it("drops a fabricated citation by code — the hedge reaches the channel, not the invented claim", async () => {
    const run = buildRun({ output: "Your rent is 900,000 KRW [from notes/rent.md]." });
    const reply = await run({
      messages: [{ content: "what is my rent?", role: "user" }],
      providerId: "log",
      source: "42"
    });
    expect(reply).not.toContain("900,000");
    expect(reply).toBe(UNGROUNDABLE_ANSWER_NOTICE);
  });

  it("passes a grounded answer through byte-identical", async () => {
    const answer = "Your rent is 900,000 KRW [from rent.md].";
    const run = buildRun({
      groundingSources: [{ source: "/home/u/.muse/notes/rent.md", text: "rent is 900,000 KRW" }],
      output: answer
    });
    const reply = await run({
      messages: [{ content: "what is my rent?", role: "user" }],
      providerId: "log",
      source: "42"
    });
    expect(reply).toBe(answer);
  });

  it("returns an empty reply unchanged (no hedge invented for a silent turn)", async () => {
    const run = buildRun({ output: "" });
    const reply = await run({
      messages: [{ content: "ok", role: "user" }],
      providerId: "log",
      source: "42"
    });
    expect(reply).toBe("");
  });
});
