import { homedir } from "node:os";

import type { MessagingProviderRegistry } from "@muse/messaging";
import type { RunDueProactiveNoticesOptions, RunDueRemindersOptions } from "@muse/proactivity";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveAmbientSignalFile, resolveInterruptionBudgetWiring, resolveProactiveTrustFile } from "./tick-daemons.js";

// Direct coverage for the daemon state-file resolvers (untested). The safety
// property is the precedence + the REFUSAL to default to the filesystem root:
// an explicit MUSE_*_FILE override wins, else $HOME/.muse/<file>, else the OS
// home — never "/" (which would scatter .muse/*.json at the root).

let savedHome: string | undefined;
beforeEach(() => { savedHome = process.env.HOME; });
afterEach(() => { if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome; });

describe("resolveAmbientSignalFile / resolveProactiveTrustFile", () => {
  it("honor an explicit override env var first (without touching HOME)", () => {
    expect(resolveAmbientSignalFile({ MUSE_AMBIENT_FILE: "/tmp/x/amb.json" })).toBe("/tmp/x/amb.json");
    expect(resolveProactiveTrustFile({ MUSE_PROACTIVE_TRUST_FILE: "/tmp/x/tr.json" })).toBe("/tmp/x/tr.json");
  });

  it("fall back to $HOME/.muse/<file> when no override", () => {
    process.env.HOME = "/tmp/fakehome";
    expect(resolveAmbientSignalFile({})).toBe("/tmp/fakehome/.muse/ambient.json");
    expect(resolveProactiveTrustFile({})).toBe("/tmp/fakehome/.muse/proactive-trust.json");
  });

  it("fall back to the OS home dir when HOME is unset — never the filesystem root", () => {
    delete process.env.HOME;
    const ambient = resolveAmbientSignalFile({});
    expect(ambient.startsWith(homedir())).toBe(true);
    expect(ambient.endsWith("/.muse/ambient.json")).toBe(true);
    expect(ambient.startsWith("/.muse")).toBe(false); // not rooted at "/"
    expect(resolveProactiveTrustFile({}).endsWith("/.muse/proactive-trust.json")).toBe(true);
  });
});

describe("resolveInterruptionBudgetWiring", () => {
  it("defaults to hourlyCap=2 / dailyCap=6 and the ~/.muse ledger + digest paths", () => {
    process.env.HOME = "/tmp/fakehome";
    const wiring = resolveInterruptionBudgetWiring({});
    expect(wiring).toEqual({
      dailyCap: 6,
      digestFile: "/tmp/fakehome/.muse/digest-queue.json",
      hourlyCap: 2,
      ledgerFile: "/tmp/fakehome/.muse/interruption-ledger.json"
    });
  });

  it("honors MUSE_INTERRUPTION_*_CAP overrides, including an explicit 0 (unlimited)", () => {
    expect(resolveInterruptionBudgetWiring({ MUSE_INTERRUPTION_DAILY_CAP: "0", MUSE_INTERRUPTION_HOURLY_CAP: "10" })).toMatchObject({
      dailyCap: 0,
      hourlyCap: 10
    });
  });

  it("falls back to the default on a non-numeric override rather than aborting", () => {
    expect(resolveInterruptionBudgetWiring({ MUSE_INTERRUPTION_HOURLY_CAP: "not-a-number" })).toMatchObject({ hourlyCap: 2 });
  });

  it("honors explicit MUSE_INTERRUPTION_LEDGER_FILE / MUSE_DIGEST_QUEUE_FILE overrides", () => {
    expect(resolveInterruptionBudgetWiring({
      MUSE_DIGEST_QUEUE_FILE: "/tmp/x/digest.json",
      MUSE_INTERRUPTION_LEDGER_FILE: "/tmp/x/ledger.json"
    })).toMatchObject({ digestFile: "/tmp/x/digest.json", ledgerFile: "/tmp/x/ledger.json" });
  });
});

describe("interruption-budget exemption pin — reminders + calendar/task-imminent notices are user-scheduled, never budgeted", () => {
  it("RunDueRemindersOptions has no interruptionBudget field (compile-time pin, checked by `tsc -b`)", () => {
    const registry = {} as MessagingProviderRegistry;
    // If this stops erroring, someone wired the budget into reminders and the
    // EXEMPT invariant (a user-scheduled alert is never suppressed) broke.
    const pin: RunDueRemindersOptions = {
      destination: "x",
      file: "x",
      // @ts-expect-error — interruptionBudget is not a valid RunDueRemindersOptions field.
      interruptionBudget: { digestFile: "d", ledgerFile: "l" },
      providerId: "x",
      registry
    };
    expect(pin).toBeDefined();
  });

  it("RunDueProactiveNoticesOptions has no interruptionBudget field (compile-time pin, checked by `tsc -b`)", () => {
    const messagingRegistry = {} as MessagingProviderRegistry;
    // Calendar/task-imminent notices are the "user already asked for this"
    // path (they set the event/task); never subject to the unasked budget.
    const pin: RunDueProactiveNoticesOptions = {
      destination: "x",
      // @ts-expect-error — interruptionBudget is not a valid RunDueProactiveNoticesOptions field.
      interruptionBudget: { digestFile: "d", ledgerFile: "l" },
      messagingRegistry,
      providerId: "x",
      sidecarFile: "x"
    };
    expect(pin).toBeDefined();
  });
});
