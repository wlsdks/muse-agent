import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentRuntime, type VetoAvoidanceProvider } from "@muse/agent-core";
import { queryVetoes, readVetoes, recordVeto, removeVeto } from "@muse/stores";
import type { ModelProvider, ModelRequest } from "@muse/model";
import { describe, expect, it } from "vitest";

/**
 * P7 target audit (the P→P seam check). P7's two bullets ARE a
 * composed correction-revocation lifecycle: a veto surfaces into
 * live runs (b1, agent stops proposing) → the user reviews it →
 * clears it (b2) → the directive must stop injecting. The
 * `mcp ↛ agent-core` dependency boundary forced the isolated
 * tests apart (b1 used an in-memory provider; b2 asserted only
 * the provider-shaped input). apps/api depends on BOTH, so this
 * is the one place the seam can be exercised for real: the REAL
 * `@muse/mcp` veto store, behind the production-shape
 * `readVetoes → VetoAvoidanceProvider` adapter, driven through
 * the REAL `createAgentRuntime` pipeline.
 */
function captureProvider(sink: { request?: ModelRequest }): ModelProvider {
  return {
    id: "capture",
    async generate(request) {
      sink.request = request;
      return { id: "r", model: request.model, output: "ok" };
    },
    async listModels() {
      return [];
    },
    async *stream() {}
  };
}

function systemText(request: ModelRequest | undefined): string {
  return (request?.messages ?? [])
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n");
}

describe("P7 audit — learn-from-correction lifecycle composes over the real store + real runtime", () => {
  it("no veto → recordVeto surfaces into a live run → review lists it → removeVeto reverts the live run", async () => {
    const vetoFile = join(mkdtempSync(join(tmpdir(), "muse-p7-seam-")), "vetoes.json");
    // The production-shape adapter — exactly what apps/api would
    // wire: read the real store, project to the duck-typed shape.
    const provider: VetoAvoidanceProvider = {
      listVetoes: async (userId) =>
        (await readVetoes(vetoFile))
          .filter((v) => v.userId === userId)
          .map((v) => ({ objectiveId: v.objectiveId, reason: v.reason, scope: v.scope }))
    };

    const sink: { request?: ModelRequest } = {};
    const runtime = createAgentRuntime({ modelProvider: captureProvider(sink), vetoAvoidanceProvider: provider });
    const run = (runId: string) =>
      runtime.run({
        messages: [{ content: "what should I do about the release?", role: "user" }],
        metadata: { userId: "stark" },
        model: "capture/model",
        runId
      });

    // 1. No correction yet → no avoidance directive.
    await run("p7-none");
    expect(systemText(sink.request)).not.toContain("[Learned Avoidance]");

    // 2. The user corrects Muse — recorded in the REAL veto store.
    await recordVeto(vetoFile, {
      id: "v_release",
      objectiveId: "obj_release",
      scope: "github:issues:write",
      userId: "stark",
      vetoedAt: "2026-05-19T13:00:00.000Z",
      reason: "wrong repo"
    });

    // b1 over the real store: the next live run carries it.
    await run("p7-vetoed");
    const vetoed = systemText(sink.request);
    expect(vetoed).toContain("[Learned Avoidance]");
    expect(vetoed).toContain("github:issues:write");
    expect(vetoed).toContain("wrong repo");

    // b2 review: the user can see what Muse learned not to do.
    expect((await queryVetoes(vetoFile, { userId: "stark" })).map((v) => v.id)).toEqual(["v_release"]);

    // b2 clear: one-tap removal from the REAL store.
    expect(await removeVeto(vetoFile, "v_release")).toBe(true);

    // The correction is revoked end-to-end: a subsequent live run
    // no longer carries the directive — clearing genuinely un-does
    // the live injection, not just a proxy.
    await run("p7-cleared");
    expect(systemText(sink.request)).not.toContain("[Learned Avoidance]");
  });
});
