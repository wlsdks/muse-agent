import { afterEach, describe, expect, it, vi } from "vitest";

import { MUSE_TAGLINE } from "./muse-identity.js";

// Force the "no model configured" branch of runChatInk by making the runtime
// assembly report no provider — everything else in @muse/autoconfigure stays
// real. This grades the LIVE first-run path (not the helper in isolation):
// the early-return branch must emit the wired onboarding message.
vi.mock("@muse/autoconfigure", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@muse/autoconfigure")>();
  return { ...actual, createMuseRuntimeAssembly: () => ({ modelProvider: undefined }) };
});

const { runChatInk } = await import("./chat-ink.js");

describe("runChatInk — no-model first run emits the wired onboarding message", () => {
  afterEach(() => { vi.restoreAllMocks(); process.exitCode = 0; });

  it("writes the local-first onboarding screen (not the old generic error) to stderr", async () => {
    let captured = "";
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof process.stderr.write);

    await runChatInk();

    expect(captured).toContain(MUSE_TAGLINE);             // identity-led, the new copy
    expect(captured).toContain("muse setup local");        // real onboarding command
    expect(captured).toContain("muse setup wizard");
    expect(captured).not.toContain("muse: no model configured yet."); // old generic opener is gone
    expect(process.exitCode).toBe(1);
  });
});
