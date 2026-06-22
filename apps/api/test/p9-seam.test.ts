import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MessagingProviderRegistry, TelegramProvider } from "@muse/messaging";
import { addObjective, readObjectives, type StandingObjective } from "@muse/stores";
import { createMessagingObjectiveActuator, createModelObjectiveEvaluator } from "@muse/proactivity";
import { describe, expect, it } from "vitest";

import { startObjectivesTick } from "../src/objectives-tick.js";

/**
 * P9 target audit (the P→P seam check). P9's bullets ARE a
 * composed production pipeline: the env-gated daemon-set function
 * builds the concrete `createModelObjectiveEvaluator` +
 * `createMessagingObjectiveActuator` and feeds them to the P9-b1
 * `startObjectivesTick` rider, which drives `runDueObjectives`
 * over the real on-disk objectives store. The isolated tests each
 * cover one link with the others faked. This exercises the WHOLE
 * chain composed exactly as `startObjectivesDaemonIfConfigured`
 * wires it — only the model verdict (a deterministic strict-JSON
 * stand-in; the live qwen3:8b decision was separately verified by
 * goal 398's real round-trip) and the HTTP boundary are faked.
 */
function fakeJsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
    status: 200
  });
}

function objective(overrides: Partial<StandingObjective> = {}): StandingObjective {
  return {
    createdAt: "2026-05-19T08:00:00.000Z",
    id: "obj_ship",
    kind: "until",
    spec: "tell me once the release is tagged",
    status: "active",
    userId: "stark",
    ...overrides
  };
}

function wire(verdict: string, posts: { text: string }[]) {
  const registry = new MessagingProviderRegistry([
    new TelegramProvider({
      baseUrl: "https://tg.test",
      fetch: async (_url, init) => {
        posts.push({ text: (JSON.parse(String(init?.body)) as { text: string }).text });
        return fakeJsonResponse({ ok: true, result: { message_id: 1 } });
      },
      token: "BOT-TOK"
    })
  ]);
  const evaluate = createModelObjectiveEvaluator({
    model: "qwen3:8b",
    modelProvider: { generate: async () => ({ output: verdict }) }
  });
  const { act, escalate } = createMessagingObjectiveActuator({
    destination: "555",
    providerId: "telegram",
    registry
  });
  return { act, escalate, evaluate };
}

describe("P9 audit — daemon-wired model evaluator → rider → real channel + durable store composes", () => {
  it("a met verdict: the objective is acted over the real channel and durably marked done", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "muse-p9-seam-")), "objectives.json");
    await addObjective(file, objective());
    const posts: { text: string }[] = [];
    const { act, escalate, evaluate } = wire('{"outcome":"met"}', posts);
    const handle = startObjectivesTick({
      act,
      escalate,
      evaluate,
      now: () => new Date("2026-05-19T12:00:00.000Z"),
      objectivesFile: file
    });
    try {
      await handle.tickOnce();
    } finally {
      handle.stop();
    }
    expect(posts).toEqual([{ text: "✅ Objective met: tell me once the release is tagged" }]);
    expect((await readObjectives(file))[0]?.status).toBe("done");
  });

  it("an unmet verdict: no channel POST, the objective stays active for backoff", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "muse-p9-seam-unmet-")), "objectives.json");
    await addObjective(file, objective());
    const posts: { text: string }[] = [];
    const { act, escalate, evaluate } = wire('{"outcome":"unmet"}', posts);
    const handle = startObjectivesTick({
      act,
      escalate,
      evaluate,
      now: () => new Date("2026-05-19T12:00:00.000Z"),
      objectivesFile: file
    });
    try {
      await handle.tickOnce();
    } finally {
      handle.stop();
    }
    expect(posts).toEqual([]);
    const after = (await readObjectives(file))[0]!;
    expect(after.status).toBe("active");
    expect(after.attempts).toBe(1);
    expect(after.nextEvalAt).toBeDefined();
  });

  it("an unmeetable verdict: escalated over the real channel and durably marked escalated", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "muse-p9-seam-esc-")), "objectives.json");
    await addObjective(file, objective());
    const posts: { text: string }[] = [];
    const { act, escalate, evaluate } = wire('{"outcome":"unmeetable","reason":"release was cancelled"}', posts);
    const handle = startObjectivesTick({
      act,
      escalate,
      evaluate,
      now: () => new Date("2026-05-19T12:00:00.000Z"),
      objectivesFile: file
    });
    try {
      await handle.tickOnce();
    } finally {
      handle.stop();
    }
    expect(posts).toEqual([
      { text: "⚠ Objective needs you: tell me once the release is tagged — release was cancelled" }
    ]);
    expect((await readObjectives(file))[0]?.status).toBe("escalated");
  });
});
