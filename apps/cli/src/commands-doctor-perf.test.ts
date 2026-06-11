import { describe, expect, it } from "vitest";

import { ollamaPerfPostureCheck } from "./commands-doctor.js";

describe("ollamaPerfPostureCheck (KV quant + flash attention posture)", () => {
  it("ok when flash attention is on and the KV cache is quantized", () => {
    const check = ollamaPerfPostureCheck({ flashAttention: "1", kvCacheType: "q8_0" });
    expect(check.status).toBe("ok");
    expect(check.name).toBe("ollama-perf");
  });

  it("warns with concrete guidance when neither is set", () => {
    const check = ollamaPerfPostureCheck({});
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("OLLAMA_FLASH_ATTENTION=1");
    expect(check.detail).toContain("OLLAMA_KV_CACHE_TYPE=q8_0");
  });

  it("warns naming only the missing half", () => {
    const check = ollamaPerfPostureCheck({ flashAttention: "true" });
    expect(check.status).toBe("warn");
    expect(check.detail).not.toContain("OLLAMA_FLASH_ATTENTION");
    expect(check.detail).toContain("OLLAMA_KV_CACHE_TYPE=q8_0");
  });

  it("q4_0 also counts as quantized", () => {
    const check = ollamaPerfPostureCheck({ flashAttention: "1", kvCacheType: "Q4_0" });
    expect(check.status).toBe("ok");
  });
});
