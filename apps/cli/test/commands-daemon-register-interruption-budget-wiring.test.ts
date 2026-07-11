import { homedir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveInterruptionBudgetWiring, resolveProactiveTrustFile } from "../src/commands-daemon-register.js";

let savedHome: string | undefined;
beforeEach(() => { savedHome = process.env.HOME; });
afterEach(() => { if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome; });

describe("resolveInterruptionBudgetWiring (muse daemon) — channel-veto fields", () => {
  it("defaults to hourlyCap=2 / dailyCap=6 and the ~/.muse ledger + digest + trust + last-delivery paths", () => {
    process.env.HOME = "/tmp/fakehome";
    expect(resolveInterruptionBudgetWiring({})).toEqual({
      dailyCap: 6,
      digestFile: join("/tmp/fakehome", ".muse", "digest-queue.json"),
      hourlyCap: 2,
      lastDeliveryFile: join("/tmp/fakehome", ".muse", "last-proactive-delivery.json"),
      ledgerFile: join("/tmp/fakehome", ".muse", "interruption-ledger.json"),
      trustLedgerFile: join("/tmp/fakehome", ".muse", "proactive-trust.json")
    });
  });

  it("trustLedgerFile matches resolveProactiveTrustFile — a single source of truth with the proactive tick", () => {
    process.env.HOME = "/tmp/fakehome";
    expect(resolveInterruptionBudgetWiring({}).trustLedgerFile).toBe(resolveProactiveTrustFile({}));
    expect(resolveInterruptionBudgetWiring({ MUSE_PROACTIVE_TRUST_FILE: "/tmp/x/tr.json" }).trustLedgerFile)
      .toBe(resolveProactiveTrustFile({ MUSE_PROACTIVE_TRUST_FILE: "/tmp/x/tr.json" }));
  });

  it("honors an explicit MUSE_LAST_PROACTIVE_FILE override for lastDeliveryFile", () => {
    expect(resolveInterruptionBudgetWiring({ MUSE_LAST_PROACTIVE_FILE: "/tmp/x/last.json" }))
      .toMatchObject({ lastDeliveryFile: "/tmp/x/last.json" });
  });

  it("falls back to the OS home dir when HOME is unset — never the filesystem root", () => {
    delete process.env.HOME;
    const wiring = resolveInterruptionBudgetWiring({});
    expect(wiring.trustLedgerFile.startsWith(homedir())).toBe(true);
    expect(wiring.trustLedgerFile.startsWith("/.muse")).toBe(false);
    expect(wiring.lastDeliveryFile.replaceAll("\\", "/").endsWith("/.muse/last-proactive-delivery.json")).toBe(true);
  });
});
