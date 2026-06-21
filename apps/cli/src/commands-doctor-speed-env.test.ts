import { describe, expect, it } from "vitest";

import { museSpeedEnvCheck } from "./commands-doctor.js";

describe("museSpeedEnvCheck (Muse-process local-model speed env posture)", () => {
  it("reports 'all default' + the num_batch tuning hint when nothing is set", () => {
    const check = museSpeedEnvCheck({});
    expect(check.status).toBe("ok");
    expect(check.name).toBe("muse-speed-env");
    expect(check.detail).toContain("all default");
    expect(check.detail).toContain("MUSE_OLLAMA_NUM_BATCH");
  });

  it("surfaces a set num_batch and DROPS the hint once it's tuned", () => {
    const check = museSpeedEnvCheck({ numBatch: "1024" });
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("num_batch=1024");
    expect(check.detail).not.toContain("set MUSE_OLLAMA_NUM_BATCH");
  });

  it("lists every tuned knob and still hints when num_batch alone is unset", () => {
    const check = museSpeedEnvCheck({ keepAlive: "2h", numCtx: "16384" });
    expect(check.detail).toContain("num_ctx=16384");
    expect(check.detail).toContain("keep_alive=2h");
    expect(check.detail).toContain("MUSE_OLLAMA_NUM_BATCH"); // still hinted (num_batch unset)
    expect(check.detail).not.toContain("num_batch=");
  });

  it("treats a whitespace-only value as unset (no broken 'num_batch=' on the wire)", () => {
    const check = museSpeedEnvCheck({ numBatch: "   " });
    expect(check.detail).not.toContain("num_batch=");
    expect(check.detail).toContain("MUSE_OLLAMA_NUM_BATCH"); // hint present
  });
});
