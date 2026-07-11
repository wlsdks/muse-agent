import { describe, expect, it } from "vitest";

import { InMemoryUserMemoryStore } from "@muse/memory";
import { createRememberFactTool } from "../src/index.js";

describe("remember_fact — fail-close secret-persistence guard", () => {
  it("refuses to remember a password value and performs NO write", async () => {
    const store = new InMemoryUserMemoryStore();
    const tool = createRememberFactTool({ store });
    const out = await tool.execute({ key: "wifi_password", value: "hunter2" }, { runId: "r", userId: "stark" }) as {
      error?: string;
      blocked?: boolean;
      kinds?: readonly string[];
    };
    expect(out.blocked).toBe(true);
    expect(out.error).toContain("암호화");
    expect(store.findByUserId("stark")).toBeUndefined();
  });

  it("an ordinary fact still writes normally (no over-block regression)", async () => {
    const store = new InMemoryUserMemoryStore();
    const tool = createRememberFactTool({ store });
    const out = await tool.execute({ key: "home_city", value: "Seoul" }, { runId: "r", userId: "stark" }) as {
      remembered?: Record<string, string>;
    };
    expect(out.remembered).toEqual({ home_city: "Seoul" });
    expect(store.findByUserId("stark")?.facts).toEqual({ home_city: "Seoul" });
  });
});
