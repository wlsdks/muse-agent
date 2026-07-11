import { describe, expect, it } from "vitest";

import { canDisconnect, providerStatus } from "./integrations-logic.js";

import type { MessagingSetupProvider } from "../api/types.js";

const base: MessagingSetupProvider = {
  configured: false,
  displayName: "Telegram",
  docsUrl: "https://core.telegram.org/bots#botfather",
  id: "telegram",
  registered: false,
  source: null
};

describe("providerStatus", () => {
  it("unconfigured → neutral 'not connected'", () => {
    expect(providerStatus(base)).toEqual({ labelKey: "int.status.notConnected", tone: "neutral" });
  });

  it("file-sourced → ok 'connected'", () => {
    expect(providerStatus({ ...base, configured: true, registered: true, source: "file" }))
      .toEqual({ labelKey: "int.status.connected", tone: "ok" });
  });

  it("env-sourced → ok 'connected via env'", () => {
    expect(providerStatus({ ...base, configured: true, registered: true, source: "env" }))
      .toEqual({ labelKey: "int.status.connectedEnv", tone: "ok" });
  });

  it("configured but not live-registered yet → warn (needs restart or reconnect)", () => {
    expect(providerStatus({ ...base, configured: true, registered: false, source: "file" }))
      .toEqual({ labelKey: "int.status.savedNotLive", tone: "warn" });
  });
});

describe("canDisconnect", () => {
  it("only a file-sourced credential can be disconnected from the UI", () => {
    expect(canDisconnect({ ...base, configured: true, source: "file" })).toBe(true);
    expect(canDisconnect({ ...base, configured: true, source: "env" })).toBe(false);
    expect(canDisconnect(base)).toBe(false);
  });
});
