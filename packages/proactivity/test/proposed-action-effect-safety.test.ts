import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  dispatchOutboundEffectOnce,
  readOutboundEffect,
  reconcileOutboundEffect,
  type MessagingProviderRegistry,
  type OutboundMessage,
  type OutboundReceipt
} from "@muse/messaging";
import {
  proposeMessageAction,
  queryActionLog,
  readProposedActions
} from "@muse/stores";
import { describe, expect, it } from "vitest";

import { confirmProposedAction } from "../src/proposed-action-confirm.js";

const NOW = new Date("2026-07-26T12:00:00.000Z");
const now = (): Date => new Date(NOW);
const execFileAsync = promisify(execFile);
const childFixture = new URL("./fixtures/proposed-action-confirm-child.ts", import.meta.url);
const draft = {
  destination: "sam@example.test",
  now,
  providerId: "email",
  reason: "owner reviewed the reschedule draft",
  summary: "Send the reschedule note",
  text: "Standup moves to 10am tomorrow.",
  userId: "owner"
} as const;

function paths() {
  const dir = mkdtempSync(join(tmpdir(), "muse-proposed-effect-"));
  return {
    actionLogFile: join(dir, "actions.json"),
    effectFile: join(dir, "outbound-effects.json"),
    file: join(dir, "proposed.json"),
    dir
  };
}

function registry(
  send: (providerId: string, message: OutboundMessage) => Promise<OutboundReceipt>
): Pick<MessagingProviderRegistry, "send"> {
  return { send };
}

describe("proposed action durable outbound effect", () => {
  it("binds the stable proposal effect and replays an accepted send with zero provider calls", async () => {
    const p = paths();
    const proposal = await proposeMessageAction(p.file, draft);
    const calls: OutboundMessage[] = [];
    const providers: string[] = [];
    const transport = registry(async (providerId, message) => {
      providers.push(providerId);
      calls.push(message);
      return { destination: message.destination, messageId: "message-1", providerId };
    });

    const first = await confirmProposedAction({
      actionLogFile: p.actionLogFile,
      file: p.file,
      id: proposal.id,
      now,
      payloadHash: proposal.payloadHash,
      registry: transport
    });
    const replay = await confirmProposedAction({
      actionLogFile: p.actionLogFile,
      file: p.file,
      id: proposal.id,
      now,
      payloadHash: proposal.payloadHash,
      registry: transport
    });

    expect(first).toEqual({ executed: true, messageId: "message-1" });
    expect(replay).toEqual({ executed: false, reason: "already executed" });
    expect(providers).toEqual(["email"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      destination: "sam@example.test",
      idempotencyKey: `proposed-action:${proposal.id}`,
      text: draft.text
    });
    expect(await readOutboundEffect(p.effectFile, `proposed-action:${proposal.id}`)).toMatchObject({
      binding: {
        destination: "sam@example.test",
        effectId: `proposed-action:${proposal.id}`,
        providerId: "email"
      },
      state: "accepted"
    });
  });

  it("snapshots mutable confirmation inputs before the first await", async () => {
    const p = paths();
    const proposal = await proposeMessageAction(p.file, draft);
    let originalCalls = 0;
    const mutableRegistry = registry(async (_providerId, message) => {
      originalCalls += 1;
      return { destination: message.destination, messageId: "snapshotted", providerId: "email" };
    });
    const options = {
      actionLogFile: p.actionLogFile,
      effectFile: p.effectFile,
      file: p.file,
      id: proposal.id,
      now,
      payloadHash: proposal.payloadHash,
      registry: mutableRegistry
    };
    const pending = confirmProposedAction(options);
    options.actionLogFile = join(p.dir, "mutated-actions.json");
    options.effectFile = join(p.dir, "mutated-effects.json");
    mutableRegistry.send = async () => {
      throw new Error("mutated registry must not be used");
    };

    expect(await pending).toEqual({ executed: true, messageId: "snapshotted" });
    expect(originalCalls).toBe(1);
    expect(existsSync(p.actionLogFile)).toBe(true);
    expect(existsSync(p.effectFile)).toBe(true);
    expect(existsSync(options.actionLogFile)).toBe(false);
    expect(existsSync(options.effectFile)).toBe(false);
  });

  it("turns a provider error into durable unknown and gives manual no-new-ID guidance on replay", async () => {
    const p = paths();
    const proposal = await proposeMessageAction(p.file, draft);
    let calls = 0;
    const transport = registry(async () => {
      calls += 1;
      throw new Error("provider timeout after request");
    });

    const first = await confirmProposedAction({
      ...p,
      id: proposal.id,
      now,
      payloadHash: proposal.payloadHash,
      registry: transport
    });
    const replay = await confirmProposedAction({
      ...p,
      id: proposal.id,
      now,
      payloadHash: proposal.payloadHash,
      registry: transport
    });

    expect(calls).toBe(1);
    expect(first).toMatchObject({ executed: false });
    expect(replay.reason).toContain("reconcile it manually");
    expect(replay.reason).toContain("do not retry with a new effect ID");
    expect((await readProposedActions(p.file))[0]!.status).toBe("pending");
    expect((await queryActionLog(p.actionLogFile, {})).filter(({ result }) => result === "failed")).toHaveLength(1);
  });

  it("keeps unknown fail-closed guidance when its failed audit store is unavailable", async () => {
    const p = paths();
    const proposal = await proposeMessageAction(p.file, draft);
    const unavailableAudit = join(p.dir, "audit-directory");
    mkdirSync(unavailableAudit);
    const result = await confirmProposedAction({
      actionLogFile: unavailableAudit,
      effectFile: p.effectFile,
      file: p.file,
      id: proposal.id,
      now,
      payloadHash: proposal.payloadHash,
      registry: registry(async () => {
        throw new Error("ambiguous provider timeout");
      })
    });
    expect(result.reason).toContain("reconcile it manually");
    expect(result.reason).toContain("failed audit could not be recorded");
    expect((await readProposedActions(p.file))[0]!.status).toBe("pending");
  });

  it("fails closed before provider dispatch when the effect ledger is corrupt", async () => {
    const p = paths();
    const proposal = await proposeMessageAction(p.file, draft);
    writeFileSync(p.effectFile, "{not-json", { mode: 0o600 });
    let calls = 0;
    const result = await confirmProposedAction({
      ...p,
      id: proposal.id,
      now,
      payloadHash: proposal.payloadHash,
      registry: registry(async () => {
        calls += 1;
        throw new Error("must not dispatch");
      })
    });
    expect(result.reason).toContain("safely blocked");
    expect(calls).toBe(0);
    expect((await readProposedActions(p.file))[0]!.status).toBe("pending");
  });

  it("keeps reconciled-not-delivered pending and requires a newly reviewed proposal", async () => {
    const p = paths();
    const proposal = await proposeMessageAction(p.file, draft);
    let calls = 0;
    const transport = registry(async () => {
      calls += 1;
      throw new Error("ambiguous provider failure");
    });
    await confirmProposedAction({
      ...p,
      id: proposal.id,
      now,
      payloadHash: proposal.payloadHash,
      registry: transport
    });
    const effectId = `proposed-action:${proposal.id}`;
    await reconcileOutboundEffect(p.effectFile, {
      actor: "owner",
      decision: "not-delivered",
      effectId,
      reason: "provider history has no matching message",
      recordedAt: "2026-07-26T12:00:01.000Z"
    });

    const result = await confirmProposedAction({
      ...p,
      id: proposal.id,
      now,
      payloadHash: proposal.payloadHash,
      registry: transport
    });
    expect(calls).toBe(1);
    expect(result.reason).toContain("create and review a new proposal");
    expect(result.reason).toContain("instead of reusing this effect ID");
    expect((await readProposedActions(p.file))[0]!.status).toBe("pending");
  });

  it("repairs an accepted delivery after an audit failure without another provider call", async () => {
    const p = paths();
    const proposal = await proposeMessageAction(p.file, draft);
    const badActionLog = join(p.dir, "audit-is-a-directory");
    mkdirSync(badActionLog);
    let calls = 0;
    const transport = registry(async (_providerId, message) => {
      calls += 1;
      return { destination: message.destination, messageId: "accepted-before-audit", providerId: "email" };
    });

    const incomplete = await confirmProposedAction({
      actionLogFile: badActionLog,
      effectFile: p.effectFile,
      file: p.file,
      id: proposal.id,
      now,
      payloadHash: proposal.payloadHash,
      registry: transport
    });
    expect(incomplete.reason).toContain("finalization is incomplete");
    expect((await readProposedActions(p.file))[0]!.status).toBe("pending");

    const repaired = await confirmProposedAction({
      ...p,
      id: proposal.id,
      now,
      payloadHash: proposal.payloadHash,
      registry: transport
    });
    expect(repaired).toEqual({ executed: true, messageId: "accepted-before-audit" });
    expect(calls).toBe(1);
    expect((await queryActionLog(p.actionLogFile, {})).filter(({ result }) => result === "performed")).toHaveLength(1);
  });

  it("repairs an accepted delivery after proposal patch failure without duplicating its audit", async () => {
    const p = paths();
    const proposal = await proposeMessageAction(p.file, draft);
    const originalProposalBytes = readFileSync(p.file, "utf8");
    let calls = 0;
    const transport = registry(async (_providerId, message) => {
      calls += 1;
      rmSync(p.file);
      mkdirSync(p.file);
      return { destination: message.destination, messageId: "accepted-before-patch", providerId: "email" };
    });

    const incomplete = await confirmProposedAction({
      ...p,
      id: proposal.id,
      now,
      payloadHash: proposal.payloadHash,
      registry: transport
    });
    expect(incomplete.reason).toContain("finalization is incomplete");
    rmSync(p.file, { force: true, recursive: true });
    writeFileSync(p.file, originalProposalBytes);

    const repaired = await confirmProposedAction({
      ...p,
      id: proposal.id,
      now,
      payloadHash: proposal.payloadHash,
      registry: transport
    });
    expect(repaired).toEqual({ executed: true, messageId: "accepted-before-patch" });
    expect(calls).toBe(1);
    expect((await queryActionLog(p.actionLogFile, {})).filter(({ result }) => result === "performed")).toHaveLength(1);
  });

  it("repairs a manually reconciled accepted effect with zero provider calls", async () => {
    const p = paths();
    const proposal = await proposeMessageAction(p.file, draft);
    let calls = 0;
    await dispatchOutboundEffectOnce({
      destination: proposal.recipient,
      effectFile: p.effectFile,
      effectId: `proposed-action:${proposal.id}`,
      now,
      providerId: proposal.channel,
      registry: registry(async () => {
        calls += 1;
        throw new Error("ambiguous send");
      }),
      text: proposal.text
    });
    await reconcileOutboundEffect(p.effectFile, {
      actor: "owner",
      decision: "accepted",
      effectId: `proposed-action:${proposal.id}`,
      reason: "found exact provider receipt",
      receipt: {
        destination: proposal.recipient,
        messageId: "manual-receipt",
        providerId: proposal.channel,
        receivedAt: "2026-07-26T12:00:01.000Z"
      },
      recordedAt: "2026-07-26T12:00:01.000Z"
    });

    const result = await confirmProposedAction({
      ...p,
      id: proposal.id,
      now,
      payloadHash: proposal.payloadHash,
      registry: registry(async () => {
        calls += 1;
        throw new Error("must not resend");
      })
    });
    expect(result).toEqual({ executed: true, messageId: "manual-receipt" });
    expect(calls).toBe(1);
    expect((await readProposedActions(p.file))[0]!.status).toBe("executed");
  });

  it("admits at most one provider call across processes and deduplicates accepted repair audit", async () => {
    const fixturePath = childFixture.pathname;
    const race = paths();
    const proposal = await proposeMessageAction(race.file, draft);
    const callsFile = join(race.dir, "provider-calls.txt");
    const childInput = {
      actionLogFile: race.actionLogFile,
      callsFile,
      effectFile: race.effectFile,
      file: race.file,
      id: proposal.id,
      payloadHash: proposal.payloadHash
    };
    await Promise.all([
      execFileAsync(process.execPath, ["--import", "tsx", fixturePath, JSON.stringify(childInput)]),
      execFileAsync(process.execPath, ["--import", "tsx", fixturePath, JSON.stringify(childInput)])
    ]);
    const providerCalls = existsSync(callsFile)
      ? readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean)
      : [];
    expect(providerCalls).toHaveLength(1);

    const repair = paths();
    const repairProposal = await proposeMessageAction(repair.file, draft);
    await dispatchOutboundEffectOnce({
      destination: repairProposal.recipient,
      effectFile: repair.effectFile,
      effectId: `proposed-action:${repairProposal.id}`,
      now,
      providerId: repairProposal.channel,
      registry: registry(async (_providerId, message) => ({
        destination: message.destination,
        messageId: "seeded-accepted",
        providerId: repairProposal.channel
      })),
      text: repairProposal.text
    });
    const repairCallsFile = join(repair.dir, "repair-provider-calls.txt");
    const repairInput = {
      actionLogFile: repair.actionLogFile,
      callsFile: repairCallsFile,
      effectFile: repair.effectFile,
      file: repair.file,
      id: repairProposal.id,
      payloadHash: repairProposal.payloadHash
    };
    await Promise.all([
      execFileAsync(process.execPath, ["--import", "tsx", fixturePath, JSON.stringify(repairInput)]),
      execFileAsync(process.execPath, ["--import", "tsx", fixturePath, JSON.stringify(repairInput)])
    ]);
    expect(existsSync(repairCallsFile)).toBe(false);
    expect((await queryActionLog(repair.actionLogFile, {})).filter(({ result }) => result === "performed")).toHaveLength(1);
    expect((await readProposedActions(repair.file))[0]!.status).toBe("executed");
  }, 20_000);
});
