import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createProposingObjectiveActuator } from "../src/objective-evaluator.js";
import type { StandingObjective } from "@muse/stores";
import { readProposedActions } from "@muse/stores";

const objective: StandingObjective = {
  id: "obj-1",
  userId: "u1",
  createdAt: "2026-01-01T00:00:00Z",
  spec: "keep inbox under 10",
  kind: "watch",
  status: "active",
};

let tmpFiles: string[] = [];
const freshFile = () => {
  const file = join(tmpdir(), `muse-prop-actuator-${tmpFiles.length}-${process.pid}.json`);
  tmpFiles.push(file);
  return file;
};
const actuator = (file: string) =>
  createProposingObjectiveActuator({ proposedActionsFile: file, providerId: "slack", destination: "C123" });

afterEach(async () => {
  await Promise.all(tmpFiles.map((f) => rm(f, { force: true })));
  tmpFiles = [];
});

describe("createProposingObjectiveActuator", () => {
  it("act() drafts a PENDING 'objective met' message (never auto-sent)", async () => {
    const file = freshFile();
    await actuator(file).act(objective);
    const proposals = await readProposedActions(file);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      kind: "message",
      status: "pending", // draft-first: proposed, not sent
      providerId: "slack",
      destination: "C123",
      userId: "u1",
      summary: "Objective met: keep inbox under 10",
      text: "✅ Objective met: keep inbox under 10",
      reason: "standing objective obj-1 met",
    });
  });

  it("escalate() drafts a PENDING 'needs you' message carrying the reason", async () => {
    const file = freshFile();
    await actuator(file).escalate(objective, "needs your call on the vendor");
    const proposals = await readProposedActions(file);
    expect(proposals[0]).toMatchObject({
      kind: "message",
      status: "pending",
      summary: "Objective needs you: keep inbox under 10",
      text: "⚠ Objective needs you: keep inbox under 10 — needs your call on the vendor",
      reason: "needs your call on the vendor",
    });
  });

  it("accumulates multiple proposals in the store", async () => {
    const file = freshFile();
    const act = actuator(file);
    await act.act(objective);
    await act.escalate(objective, "blocked");
    const proposals = await readProposedActions(file);
    expect(proposals).toHaveLength(2);
    expect(proposals.every((p) => p.status === "pending")).toBe(true);
  });
});
