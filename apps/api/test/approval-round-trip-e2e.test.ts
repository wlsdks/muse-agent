import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createChannelApprovalGate, LogMessagingProvider, MessagingProviderRegistry, listPendingApprovals } from "@muse/messaging";
import { readActionLog } from "@muse/stores";
import { runActuatorByName } from "@muse/domain-tools";
import type { JsonObject } from "@muse/shared";
import { describe, expect, it } from "vitest";

import { createChannelPendingRecorder } from "../src/channel-pending-recorder.js";
import { handleInboundApprovalReply } from "../src/inbound-approval-handler.js";

// END-TO-END approval round-trip (backlog P2): composes the FOUR real seams the
// isolated tests each cover separately — the channel approval gate (refuses a
// risky tool + records the refusal), the pending-approval store (persists the
// re-run args, channel-scoped, TTL'd), the inbound-approval handler (a "yes"
// reply resolves it), and runActuatorByName (re-runs the actuator through its own
// fail-closed gate). Contract-faithful throughout: a REAL MessagingProviderRegistry
// + LogMessagingProvider for the notice channel, a REAL fetch fake for the
// actuator HTTP — never a stubbed registry (outbound-safety.md acceptance).

const tmp = (name: string): string => join(mkdtempSync(join(tmpdir(), "muse-appr-e2e-")), name);
const recordingFetch = (status = 200): { fetchImpl: typeof fetch; calls: string[] } => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL) => { calls.push(String(url)); return new Response("{}", { status }); }) as unknown as typeof fetch;
  return { calls, fetchImpl };
};

const PROVIDER = "log";
const SOURCE = "42";
const NOW = () => new Date("2026-05-22T10:00:00.000Z");

// The gate wired to record refusals into the pending store (the production seam).
const buildGate = (pendingFile: string, noticeFile: string) => {
  const registry = new MessagingProviderRegistry([new LogMessagingProvider({ file: noticeFile, id: PROVIDER, now: NOW })]);
  const recordRefusal = createChannelPendingRecorder({ now: NOW, pendingFile, providerId: PROVIDER, source: SOURCE, ttlMs: 60 * 60 * 1000 });
  return createChannelApprovalGate({ providerId: PROVIDER, recordRefusal, registry, source: SOURCE });
};

// autoRun = the REAL runActuatorByName, auto-approving (the inbound "yes" IS the
// explicit confirm of the already-shown draft, per outbound-safety draft-first).
const autoRunVia = (actionLogFile: string, fetchImpl: typeof fetch) =>
  (entry: { tool: string; arguments: Record<string, unknown> }) =>
    runActuatorByName(entry.tool, entry.arguments as JsonObject, {
      actionLogFile,
      emailApprovalGate: () => ({ approved: true }),
      fetchImpl,
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      userId: "telegram:42",
      webApprovalGate: () => ({ approved: true }),
    });

describe("approval round-trip e2e (gate refuses+records → inbound yes → real re-run → logged → cleared)", () => {
  it("a risky web_action is refused & recorded, then an inbound yes re-runs it for real and clears it", async () => {
    const pendingFile = tmp("pending.json");
    const noticeFile = tmp("notice.log");
    const actionLogFile = tmp("action-log.json");
    const url = "http://x.test/book";

    // 1. REFUSAL leg: the gate refuses the write/execute tool and records a pending approval + sends a notice.
    const decision = await buildGate(pendingFile, noticeFile)({
      risk: "execute",
      runId: "r1",
      toolCall: { arguments: { summary: "Book a table", url }, name: "web_action" },
      userId: "telegram:42",
    });
    expect(decision.allowed).toBe(false); // never runs on the gate's own judgement
    const pending = await listPendingApprovals(pendingFile, NOW);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ providerId: PROVIDER, source: SOURCE, tool: "web_action", arguments: { url } });
    expect(await readFile(noticeFile, "utf8")).toContain("web_action"); // user was told

    // 2. APPROVAL leg: the inbound "yes" resolves the SAME pending entry and re-runs it through runActuatorByName.
    const { calls, fetchImpl } = recordingFetch();
    const reply = await handleInboundApprovalReply({
      autoRun: autoRunVia(actionLogFile, fetchImpl),
      now: NOW,
      pendingFile,
      providerId: PROVIDER,
      source: SOURCE,
      text: "yes",
    });

    expect(calls).toEqual([url]); // the real actuator HTTP fired exactly once
    expect(reply).toContain("Done — ran web_action");
    expect(await listPendingApprovals(pendingFile, NOW)).toHaveLength(0); // cleared (replay-guard)
    expect((await readActionLog(actionLogFile)).map((e) => e.result)).toEqual(["performed"]); // recorded
  });

  it("a READ-risk tool sails through the gate — nothing is recorded, nothing to approve", async () => {
    const pendingFile = tmp("pending.json");
    const decision = await buildGate(pendingFile, tmp("notice.log"))({
      risk: "read",
      runId: "r2",
      toolCall: { arguments: { url: "http://x.test/read" }, name: "web_read" },
      userId: "telegram:42",
    });
    expect(decision.allowed).toBe(true);
    expect(await listPendingApprovals(pendingFile, NOW)).toHaveLength(0);
  });

  it("channel scope holds end-to-end: a yes from a DIFFERENT source does not re-run the pending action", async () => {
    const pendingFile = tmp("pending.json");
    await buildGate(pendingFile, tmp("notice.log"))({
      risk: "execute",
      runId: "r3",
      toolCall: { arguments: { summary: "Book", url: "http://x.test/book" }, name: "web_action" },
      userId: "telegram:42",
    });
    expect(await listPendingApprovals(pendingFile, NOW)).toHaveLength(1);

    const { calls, fetchImpl } = recordingFetch();
    const reply = await handleInboundApprovalReply({
      autoRun: autoRunVia(tmp("action-log.json"), fetchImpl),
      now: NOW,
      pendingFile,
      providerId: PROVIDER,
      source: "99", // a different channel
      text: "yes",
    });
    expect(reply).toBeUndefined(); // not this channel's approval → falls through to the agent
    expect(calls).toHaveLength(0); // no external effect
    expect(await listPendingApprovals(pendingFile, NOW)).toHaveLength(1); // still pending for source 42
  });
});
