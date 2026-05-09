import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CalendarProviderError,
  CalendarProviderRegistry,
  CalendarValidationError,
  FileCalendarCredentialStore,
  LocalCalendarProvider
} from "../src/index.js";

describe("LocalCalendarProvider", () => {
  let dir: string;
  let provider: LocalCalendarProvider;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "muse-cal-"));
    provider = new LocalCalendarProvider({ file: join(dir, "calendar.json"), idFactory: counter() });
  });

  afterEach(() => {
    rmSync(dir, { force: true, recursive: true });
  });

  it("returns an empty list when the file does not exist", async () => {
    const events = await provider.listEvents({ from: new Date(0), to: new Date(Date.now() + 86_400_000) });
    expect(events).toEqual([]);
  });

  it("creates and lists events", async () => {
    const created = await provider.createEvent({
      endsAt: new Date("2026-05-15T11:00:00Z"),
      notes: "weekly sync",
      startsAt: new Date("2026-05-15T10:00:00Z"),
      tags: ["work"],
      title: "Standup"
    });

    expect(created).toMatchObject({ id: "cal_1", providerId: "local", title: "Standup" });

    const events = await provider.listEvents({ from: new Date(0), to: new Date("2026-05-16T00:00:00Z") });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: "cal_1", title: "Standup", tags: ["work"] });
  });

  it("filters events outside the range", async () => {
    await provider.createEvent({
      endsAt: new Date("2026-05-15T11:00:00Z"),
      startsAt: new Date("2026-05-15T10:00:00Z"),
      title: "In range"
    });
    await provider.createEvent({
      endsAt: new Date("2026-06-15T11:00:00Z"),
      startsAt: new Date("2026-06-15T10:00:00Z"),
      title: "Out of range"
    });

    const events = await provider.listEvents({
      from: new Date("2026-05-14T00:00:00Z"),
      to: new Date("2026-05-16T00:00:00Z")
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.title).toBe("In range");
  });

  it("updates an existing event", async () => {
    const created = await provider.createEvent({
      endsAt: new Date("2026-05-15T11:00:00Z"),
      startsAt: new Date("2026-05-15T10:00:00Z"),
      title: "Old title"
    });

    const updated = await provider.updateEvent(created.id, { location: "Room 1", title: "New title" });
    expect(updated).toMatchObject({ location: "Room 1", title: "New title" });
  });

  it("deletes an event", async () => {
    const created = await provider.createEvent({
      endsAt: new Date("2026-05-15T11:00:00Z"),
      startsAt: new Date("2026-05-15T10:00:00Z"),
      title: "Doomed"
    });

    await provider.deleteEvent(created.id);
    const events = await provider.listEvents({ from: new Date(0), to: new Date(Date.now() + 86_400_000) });
    expect(events).toEqual([]);
  });

  it("rejects events whose endsAt precedes startsAt", async () => {
    await expect(
      provider.createEvent({
        endsAt: new Date("2026-05-15T09:00:00Z"),
        startsAt: new Date("2026-05-15T10:00:00Z"),
        title: "Reversed"
      })
    ).rejects.toBeInstanceOf(CalendarValidationError);
  });

  it("throws EVENT_NOT_FOUND on missing ids", async () => {
    await expect(provider.deleteEvent("missing")).rejects.toBeInstanceOf(CalendarProviderError);
    await expect(provider.updateEvent("missing", { title: "x" })).rejects.toBeInstanceOf(CalendarProviderError);
  });

  it("survives a corrupt file by treating it as empty", async () => {
    const created = await provider.createEvent({
      endsAt: new Date("2026-05-15T11:00:00Z"),
      startsAt: new Date("2026-05-15T10:00:00Z"),
      title: "Survives"
    });
    expect(created.id).toBe("cal_1");
    // simulate corruption — the next read should fall through to []
    const file = join(dir, "calendar.json");
    require("node:fs").writeFileSync(file, "not json");
    const events = await provider.listEvents({ from: new Date(0), to: new Date(Date.now() + 86_400_000) });
    expect(events).toEqual([]);
  });
});

describe("CalendarProviderRegistry", () => {
  it("requires explicit provider id for mutations and falls back to primary on omission", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-cal-reg-"));
    const provider = new LocalCalendarProvider({ file: join(dir, "cal.json") });
    const registry = new CalendarProviderRegistry([provider]);

    expect(registry.has("local")).toBe(true);
    expect(registry.describe()).toHaveLength(1);

    const created = await registry.createEvent(undefined, {
      endsAt: new Date("2026-05-15T11:00:00Z"),
      startsAt: new Date("2026-05-15T10:00:00Z"),
      title: "Primary route"
    });
    expect(created.providerId).toBe("local");

    expect(() => registry.require("ghost")).toThrowError(CalendarProviderError);

    rmSync(dir, { force: true, recursive: true });
  });
});

describe("FileCalendarCredentialStore", () => {
  it("persists, reads, and removes provider credentials", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-cred-"));
    const store = new FileCalendarCredentialStore(join(dir, "credentials.json"));

    expect(await store.list()).toEqual([]);
    expect(await store.load("gcal")).toBeUndefined();

    await store.save("gcal", { clientId: "abc", refreshToken: "tok" });
    expect(await store.load("gcal")).toEqual({ clientId: "abc", refreshToken: "tok" });
    expect(await store.list()).toEqual(["gcal"]);

    await store.remove("gcal");
    expect(await store.load("gcal")).toBeUndefined();
    expect(await store.list()).toEqual([]);

    rmSync(dir, { force: true, recursive: true });
  });
});

function counter(): () => string {
  let i = 0;
  return () => `cal_${++i}`;
}
