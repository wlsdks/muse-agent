import { describe, expect, it } from "vitest";

import { createChannelDaemonSupervisor } from "../src/channel-daemon-supervisor.js";

// The truthful-status seam: the settings/integrations surfaces must report
// whether a channel daemon is ACTUALLY running (a live handle), never just
// whether its env flag is set — a flag-on/daemon-dead mismatch is exactly
// the lying badge the UX evaluation flagged.

describe("createChannelDaemonSupervisor", () => {
  it("reports running=true only while a live handle is registered", () => {
    const supervisor = createChannelDaemonSupervisor();
    expect(supervisor.isRunning("telegram-poll")).toBe(false);

    supervisor.adopt("telegram-poll", { stop: () => undefined });
    expect(supervisor.isRunning("telegram-poll")).toBe(true);

    supervisor.stop("telegram-poll");
    expect(supervisor.isRunning("telegram-poll")).toBe(false);
  });

  it("adopting a replacement handle stops the previous one (no orphan daemons)", () => {
    const supervisor = createChannelDaemonSupervisor();
    let firstStopped = false;
    supervisor.adopt("telegram-poll", { stop: () => { firstStopped = true; } });
    supervisor.adopt("telegram-poll", { stop: () => undefined });
    expect(firstStopped).toBe(true);
    expect(supervisor.isRunning("telegram-poll")).toBe(true);
  });

  it("adopts the replacement and clears stopped state even when an old handle throws during cleanup", () => {
    const supervisor = createChannelDaemonSupervisor();
    supervisor.adopt("telegram-poll", { stop: () => { throw new Error("already broken"); } });
    supervisor.adopt("telegram-poll", { stop: () => undefined });
    expect(supervisor.isRunning("telegram-poll")).toBe(true);

    supervisor.stop("telegram-poll");
    expect(supervisor.isRunning("telegram-poll")).toBe(false);
  });

  it("keeps a replacement live when the retiring handle re-enters stop", () => {
    const supervisor = createChannelDaemonSupervisor();
    let replacementStops = 0;
    const replacement = { stop: () => { replacementStops += 1; } };

    supervisor.adopt("telegram-poll", {
      stop: () => supervisor.stop("telegram-poll"),
    });
    supervisor.adopt("telegram-poll", replacement);

    expect(replacementStops).toBe(0);
    expect(supervisor.isRunning("telegram-poll")).toBe(true);
  });

  it("keeps a replacement live when the retiring handle re-adopts that same candidate", () => {
    const supervisor = createChannelDaemonSupervisor();
    let replacementStops = 0;
    const replacement = { stop: () => { replacementStops += 1; } };

    supervisor.adopt("telegram-poll", {
      stop: () => supervisor.adopt("telegram-poll", replacement),
    });
    supervisor.adopt("telegram-poll", replacement);

    expect(replacementStops).toBe(0);
    expect(supervisor.isRunning("telegram-poll")).toBe(true);
  });

  it("treats adopting an already-live handle as an idempotent operation", () => {
    const supervisor = createChannelDaemonSupervisor();
    let stops = 0;
    const handle = { stop: () => { stops += 1; } };

    supervisor.adopt("telegram-poll", handle);
    supervisor.adopt("telegram-poll", handle);

    expect(stops).toBe(0);
    expect(supervisor.isRunning("telegram-poll")).toBe(true);
  });

  it("status() snapshots every known daemon with running state and notes", () => {
    const supervisor = createChannelDaemonSupervisor();
    supervisor.adopt("telegram-poll", { stop: () => undefined });
    supervisor.noteIngest("telegram-poll", 3);
    supervisor.noteError("matrix-sync", "sync failed");

    const status = supervisor.status();
    expect(status["telegram-poll"]).toMatchObject({ running: true });
    expect(typeof status["telegram-poll"]?.lastIngestAtIso).toBe("string");
    expect(status["matrix-sync"]).toMatchObject({ lastError: "sync failed", running: false });
  });

  it("normalizes malformed ingest counts before exposing them in the status DTO", () => {
    const supervisor = createChannelDaemonSupervisor();
    supervisor.noteIngest("telegram-poll", Number.NaN);
    expect(supervisor.status()["telegram-poll"]?.lastIngestCount).toBe(0);
    supervisor.noteIngest("telegram-poll", 3.5);
    expect(supervisor.status()["telegram-poll"]?.lastIngestCount).toBe(0);
  });

  it("stopAll halts everything (server onClose seam)", () => {
    const supervisor = createChannelDaemonSupervisor();
    const stops: string[] = [];
    supervisor.adopt("a", { stop: () => stops.push("a") });
    supervisor.adopt("b", { stop: () => stops.push("b") });
    supervisor.stopAll();
    expect(stops.sort()).toEqual(["a", "b"]);
    expect(supervisor.isRunning("a")).toBe(false);
  });

  it("does not retain a daemon adopted by a retiring handle during stopAll", () => {
    const supervisor = createChannelDaemonSupervisor();
    let reentrantStops = 0;

    supervisor.adopt("a", {
      stop: () => supervisor.adopt("a", { stop: () => { reentrantStops += 1; } }),
    });
    supervisor.stopAll();

    expect(reentrantStops).toBe(1);
    expect(supervisor.isRunning("a")).toBe(false);
  });

  it("does not double-stop a live sibling re-adopted during shutdown", () => {
    const supervisor = createChannelDaemonSupervisor();
    let siblingStops = 0;
    const sibling = { stop: () => { siblingStops += 1; } };

    supervisor.adopt("a", { stop: () => supervisor.adopt("b", sibling) });
    supervisor.adopt("b", sibling);
    supervisor.stopAll();

    expect(siblingStops).toBe(1);
    expect(supervisor.isRunning("b")).toBe(false);
  });

  it("does not recursively stop a handle that re-adopts itself during cleanup", () => {
    const supervisor = createChannelDaemonSupervisor();
    let stops = 0;
    const handle = {
      stop: () => {
        stops += 1;
        supervisor.adopt("telegram-poll", handle);
      },
    };

    supervisor.adopt("telegram-poll", handle);
    supervisor.stopAll();

    expect(stops).toBe(1);
    expect(supervisor.isRunning("telegram-poll")).toBe(false);
  });

  it("rejects late daemon registrations after the terminal server shutdown", () => {
    const supervisor = createChannelDaemonSupervisor();
    let lateStops = 0;

    supervisor.stopAll();
    supervisor.adopt("telegram-poll", { stop: () => { lateStops += 1; } });

    expect(lateStops).toBe(1);
    expect(supervisor.isRunning("telegram-poll")).toBe(false);
  });
});
