import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resetCliContext, setCliContext } from "./cli-context.js";
import {
  DATA_STEPS,
  registerSetupDataCommand,
  renderDataSetupSummary,
  runDataSetup,
  type DataSetupActions,
  type DataSetupDeps
} from "./commands-setup-data.js";
import type { ProgramIO } from "./program.js";

function makeIo(): { io: ProgramIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const io = { stderr: (m: string) => err.push(m), stdout: (m: string) => out.push(m) } as unknown as ProgramIO;
  return { err, io, out };
}

function makeActions(overrides: Partial<DataSetupActions> = {}): DataSetupActions {
  return {
    importContacts: vi.fn(async () => ({ imported: 7, skipped: 1, total: 9, updated: 2 })),
    syncBrowsing: vi.fn(async () => ({ synced: 42, total: 100 })),
    ...overrides
  };
}

/** Confirm that says yes only for the step prompts whose text matches an accepted id. */
function confirmFor(acceptedIds: readonly string[]): DataSetupDeps["confirm"] {
  return async (message: string) => {
    const step = DATA_STEPS.find((s) => message.includes(s.prompt));
    return step !== undefined && acceptedIds.includes(step.id);
  };
}

const baseDeps = (over: Partial<DataSetupDeps>): DataSetupDeps => ({
  actions: makeActions(),
  confirm: confirmFor([]),
  env: {},
  flags: {},
  io: makeIo().io,
  ...over
});

describe("runDataSetup — consent-first connect-your-data flow", () => {
  it("all-decline ⇒ nothing runs, nothing staged (the consent pin)", async () => {
    const actions = makeActions();
    const { io } = makeIo();
    const result = await runDataSetup(baseDeps({ actions, confirm: confirmFor([]), io }));

    expect(actions.importContacts).not.toHaveBeenCalled();
    expect(actions.syncBrowsing).not.toHaveBeenCalled();
    expect(result.stagedSwitches).toEqual([]);
    expect(result.contacts).toBeUndefined();
    expect(result.browsing).toBeUndefined();
    expect(result.declined).toEqual(DATA_STEPS.map((s) => s.id));
  });

  it("accept contacts ⇒ import fn called once, count captured + rendered", async () => {
    const actions = makeActions();
    const { io, out } = makeIo();
    const result = await runDataSetup(baseDeps({ actions, confirm: confirmFor(["contacts"]), io }));

    expect(actions.importContacts).toHaveBeenCalledTimes(1);
    expect(result.contacts).toEqual({ imported: 7, skipped: 1, total: 9, updated: 2 });
    expect(out.join("")).toContain("imported 7 new");
  });

  it("accept browsing ⇒ sync fn called + count captured", async () => {
    const actions = makeActions();
    const result = await runDataSetup(baseDeps({ actions, confirm: confirmFor(["browsing"]) }));

    expect(actions.syncBrowsing).toHaveBeenCalledTimes(1);
    expect(result.browsing).toEqual({ synced: 42, total: 100 });
  });

  it("a failing action warns and continues to the next step (fail-soft)", async () => {
    const actions = makeActions({
      importContacts: vi.fn(async () => { throw new Error("TCC denied"); })
    });
    const { io, err } = makeIo();
    const result = await runDataSetup(baseDeps({ actions, confirm: confirmFor(["contacts", "browsing"]), io }));

    expect(result.failed).toContain("contacts");
    expect(result.contacts).toBeUndefined();
    expect(actions.syncBrowsing).toHaveBeenCalledTimes(1); // did NOT abort the wizard
    expect(result.browsing).toBeDefined();
    expect(err.join("")).toContain("continuing");
  });

  it("accepted switches stage exactly their env exports; declined ones stage none", async () => {
    const result = await runDataSetup(baseDeps({ confirm: confirmFor(["browsingAuto", "notesMirror"]) }));

    expect(result.stagedSwitches).toEqual([
      "export MUSE_BROWSING_AUTO_SYNC=true",
      "export MUSE_APPLE_NOTES_MIRROR=true"
    ]);
    expect(result.stagedSwitches.join("")).not.toContain("MUSE_APPLE_REMINDERS_MIRROR");
  });

  it("a switch already true in the env is reported as already-on, never re-prompted or re-staged", async () => {
    const confirmSpy = vi.fn(confirmFor(["remindersMirror"]));
    const result = await runDataSetup(baseDeps({
      confirm: confirmSpy,
      env: { MUSE_BROWSING_AUTO_SYNC: "true" }
    }));

    expect(result.alreadyEnabled).toContain("MUSE_BROWSING_AUTO_SYNC");
    expect(result.stagedSwitches).not.toContain("export MUSE_BROWSING_AUTO_SYNC=true");
    // browsingAuto prompt was skipped entirely
    expect(confirmSpy.mock.calls.some(([m]) => (m as string).includes("auto-syncing"))).toBe(false);
  });

  it("flag mode runs exactly the flagged steps and NEVER prompts (scripted consent)", async () => {
    const actions = makeActions();
    const confirmSpy = vi.fn(async () => { throw new Error("confirm must not be called in flag mode"); });
    const result = await runDataSetup(baseDeps({
      actions,
      confirm: confirmSpy,
      flags: { browsingAuto: true, contacts: true }
    }));

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(actions.importContacts).toHaveBeenCalledTimes(1);
    expect(actions.syncBrowsing).not.toHaveBeenCalled();
    expect(result.stagedSwitches).toEqual(["export MUSE_BROWSING_AUTO_SYNC=true"]);
  });
});

describe("muse setup data — honours --no-input / non-TTY (never blocks on a clack prompt)", () => {
  afterEach(() => {
    resetCliContext();
  });

  it("under --no-input takes the safe default (declines all) without prompting or hanging", async () => {
    setCliContext({ noColor: false, noInput: true, quiet: false });
    const out: string[] = [];
    const io = {
      stderr: () => undefined,
      stdout: (m: string) => out.push(m)
    } as unknown as ProgramIO;

    const program = new Command("muse");
    program.exitOverride();
    program.command("setup").description("setup");
    registerSetupDataCommand(program, io);

    // If the no-input signal were ignored this would block on clack's confirm
    // waiting for a TTY. A resolved parseAsync IS the non-blocking proof.
    await program.parseAsync(["node", "muse", "setup", "data"]);

    const text = out.join("");
    expect(text).toContain("Nothing enabled");
    // No step actually ran (safe default = decline).
    expect(text).not.toContain("imported");
    expect(text).not.toContain("synced");
  });
});

describe("renderDataSetupSummary", () => {
  it("emits the env block + try-it-now line when something was enabled", () => {
    const { io, out } = makeIo();
    renderDataSetupSummary(io, {
      alreadyEnabled: [],
      browsing: undefined,
      contacts: { imported: 3, skipped: 0, total: 3, updated: 0 },
      declined: [],
      failed: [],
      stagedSwitches: ["export MUSE_APPLE_NOTES_MIRROR=true"]
    });
    const text = out.join("");
    expect(text).toContain("export MUSE_APPLE_NOTES_MIRROR=true");
    expect(text).toContain("muse ask");
  });

  it("on a pure all-decline result says nothing was enabled and skips the env block", () => {
    const { io, out } = makeIo();
    renderDataSetupSummary(io, {
      alreadyEnabled: [],
      browsing: undefined,
      contacts: undefined,
      declined: DATA_STEPS.map((s) => s.id),
      failed: [],
      stagedSwitches: []
    });
    const text = out.join("");
    expect(text).toContain("Nothing enabled");
    expect(text).not.toContain("export ");
  });
});
