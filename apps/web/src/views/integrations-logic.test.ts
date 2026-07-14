import { describe, expect, it } from "vitest";

import { canDisconnect, daemonBadge, emailStatusView, providerStatus, requiresHomeserver, schedulerDeliveryValue } from "./integrations-logic.js";

import type { EmailStatusResponse, MessagingSetupProvider } from "../api/types.js";

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

describe("requiresHomeserver", () => {
  it("only matrix needs a homeserver URL alongside the token", () => {
    expect(requiresHomeserver("matrix")).toBe(true);
    expect(requiresHomeserver("telegram")).toBe(false);
    expect(requiresHomeserver("discord")).toBe(false);
    expect(requiresHomeserver("slack")).toBe(false);
    expect(requiresHomeserver("line")).toBe(false);
  });
});

describe("canDisconnect", () => {
  it("only a file-sourced credential can be disconnected from the UI", () => {
    expect(canDisconnect({ ...base, configured: true, source: "file" })).toBe(true);
    expect(canDisconnect({ ...base, configured: true, source: "env" })).toBe(false);
    expect(canDisconnect(base)).toBe(false);
  });
});

describe("emailStatusView", () => {
  it("configured via OAuth → ok, auto-refreshes copy", () => {
    const status: EmailStatusResponse = { configured: true, hasRefreshToken: true, method: "oauth" };
    expect(emailStatusView(status)).toEqual({ messageKey: "int.email.connectedOauth", tone: "ok" });
  });

  it("configured via MUSE_GMAIL_TOKEN env → warn (raw token, expires hourly)", () => {
    const status: EmailStatusResponse = { configured: true, method: "env" };
    expect(emailStatusView(status)).toEqual({ messageKey: "int.email.connectedEnv", tone: "warn" });
  });

  it("not configured → neutral", () => {
    const status: EmailStatusResponse = { configured: false, method: null };
    expect(emailStatusView(status)).toEqual({ messageKey: "int.email.notConfigured", tone: "neutral" });
  });

  it("undefined (query still loading/errored) degrades to not-configured, never throws", () => {
    expect(emailStatusView(undefined)).toEqual({ messageKey: "int.email.notConfigured", tone: "neutral" });
  });
});

describe("schedulerDeliveryValue", () => {
  it("prefixes the provider id onto a bare owner id", () => {
    expect(schedulerDeliveryValue("telegram", "8303165569")).toBe("telegram:8303165569");
  });

  it("does NOT double the prefix when the owner id already carries it", () => {
    expect(schedulerDeliveryValue("matrix", "matrix:@user:hs.test")).toBe("matrix:@user:hs.test");
  });

  it("a DIFFERENT provider's prefix on the owner id is not treated as already-prefixed", () => {
    // Only a match of THIS provider's own prefix should be treated as
    // already-prefixed — a coincidental colon from another provider must
    // still get telegram: prepended.
    expect(schedulerDeliveryValue("telegram", "discord:12345")).toBe("telegram:discord:12345");
  });
});

describe("daemonBadge", () => {
  const flag = (enabled: boolean, running?: boolean) => ({
    enabled,
    key: "MUSE_TELEGRAM_POLL_ENABLED",
    label: "Telegram inbound polling",
    ...(running !== undefined ? { running } : {})
  });

  it("enabled + running → ok 'running'", () => {
    expect(daemonBadge(flag(true, true))).toEqual({ labelKey: "int.daemon.running", tone: "ok" });
  });

  it("enabled but NOT running → warn (the truthful lying-badge fix)", () => {
    expect(daemonBadge(flag(true, false))).toEqual({ labelKey: "int.daemon.enabledNotRunning", tone: "warn" });
  });

  it("disabled → neutral 'off' regardless of running info", () => {
    expect(daemonBadge(flag(false, false))).toEqual({ labelKey: "int.daemon.off", tone: "neutral" });
    expect(daemonBadge(flag(false))).toEqual({ labelKey: "int.daemon.off", tone: "neutral" });
  });

  it("enabled without running info keeps the plain 'on' (older servers)", () => {
    expect(daemonBadge(flag(true))).toEqual({ labelKey: "int.daemon.on", tone: "ok" });
  });
});
