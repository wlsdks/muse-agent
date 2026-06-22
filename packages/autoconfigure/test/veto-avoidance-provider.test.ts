import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recordVeto } from "@muse/stores";
import { describe, expect, it } from "vitest";

import { buildVetoAvoidanceProvider } from "../src/context-engineering-builders.js";
import type { MuseEnvironment } from "../src/index.js";

function envWith(overrides: Record<string, string>): MuseEnvironment {
  return overrides as unknown as MuseEnvironment;
}

describe("buildVetoAvoidanceProvider — P7 learn-from-correction wired into the production runtime", () => {
  it("adapts the real ~/.muse/vetoes.json store to the runtime's VetoAvoidanceProvider, user-scoped", async () => {
    const vetoesFile = join(mkdtempSync(join(tmpdir(), "muse-veto-prov-")), "vetoes.json");
    await recordVeto(vetoesFile, {
      id: "v1",
      objectiveId: "obj_release",
      scope: "github:issues:write",
      userId: "stark",
      vetoedAt: "2026-05-19T13:00:00.000Z",
      reason: "wrong repo"
    });
    await recordVeto(vetoesFile, {
      id: "v2",
      objectiveId: "obj_x",
      scope: "email:send",
      userId: "wintermute",
      vetoedAt: "2026-05-19T13:00:00.000Z"
    });

    const provider = buildVetoAvoidanceProvider(envWith({ MUSE_VETOES_FILE: vetoesFile }));
    expect(provider).toBeDefined();
    expect(await provider!.listVetoes("stark")).toEqual([
      { objectiveId: "obj_release", reason: "wrong repo", scope: "github:issues:write" }
    ]);
    // user-scoped: another user's veto is not leaked
    expect(await provider!.listVetoes("nobody")).toEqual([]);
  });

  it("is opt-out via MUSE_VETO_AVOIDANCE=false; default-on; tolerant of a missing store", async () => {
    expect(buildVetoAvoidanceProvider(envWith({ MUSE_VETO_AVOIDANCE: "false" }))).toBeUndefined();
    const provider = buildVetoAvoidanceProvider(
      envWith({ MUSE_VETOES_FILE: join(tmpdir(), "muse-no-such-vetoes.json") })
    );
    expect(provider).toBeDefined();
    expect(await provider!.listVetoes("stark")).toEqual([]);
  });
});
