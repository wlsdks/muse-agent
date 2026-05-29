import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { MuseEnvironment } from "../src/index.js";
import { buildCalendarRegistry } from "../src/registry-builders/calendar.js";

let dir: string;
let credFile: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "build-calendar-registry-"));
  // Hermetic: an ABSENT credentials path so a real host file can't leak in.
  credFile = join(dir, "absent-credentials.json");
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const base = () => ({ MUSE_CREDENTIALS_FILE: credFile, MUSE_LOCAL_CALENDAR_FILE: join(dir, "cal.json") });
const ids = (over: Record<string, string | undefined> = {}): readonly string[] =>
  buildCalendarRegistry({ ...base(), ...over } as unknown as MuseEnvironment).list().map((p) => p.id);
const writeCredentials = async (providers: Record<string, unknown>) => {
  await fs.writeFile(credFile, JSON.stringify({ providers }));
};

const GCAL = { MUSE_GCAL_CLIENT_ID: "c", MUSE_GCAL_CLIENT_SECRET: "s", MUSE_GCAL_REFRESH_TOKEN: "r" };
const CALDAV = { MUSE_CALDAV_APP_PASSWORD: "p", MUSE_CALDAV_URL: "u", MUSE_CALDAV_USERNAME: "n" };

describe("buildCalendarRegistry — provider-list parsing", () => {
  it("defaults to local on unset / empty / whitespace", () => {
    expect(ids()).toEqual(["local"]);
    expect(ids({ MUSE_CALENDAR_PROVIDERS: "" })).toEqual(["local"]);
    expect(ids({ MUSE_CALENDAR_PROVIDERS: "   " })).toEqual(["local"]);
  });

  it("splits a comma list with trim, lowercase, and empty-entry drop", () => {
    expect(ids({ MUSE_CALENDAR_PROVIDERS: "  LOCAL , MacOS ,, " })).toEqual(["local", "macos"]);
  });

  it("preserves order (primary = first) and collapses duplicates", () => {
    const registry = buildCalendarRegistry({ ...base(), MUSE_CALENDAR_PROVIDERS: "macos,local" } as unknown as MuseEnvironment);
    expect(registry.list().map((p) => p.id)).toEqual(["macos", "local"]);
    expect(registry.primary()?.id).toBe("macos");
    expect(ids({ MUSE_CALENDAR_PROVIDERS: "local,local" })).toEqual(["local"]);
  });

  it("silently skips an unknown provider id", () => {
    expect(ids({ MUSE_CALENDAR_PROVIDERS: "local,bogus" })).toEqual(["local"]);
  });
});

describe("buildCalendarRegistry — local + macos (no required credentials)", () => {
  it("always builds local", () => {
    expect(buildCalendarRegistry(base() as unknown as MuseEnvironment).has("local")).toBe(true);
  });

  it("registers macos with or without a calendar-name scope", () => {
    expect(ids({ MUSE_CALENDAR_PROVIDERS: "macos" })).toEqual(["macos"]);
    expect(ids({ MUSE_CALENDAR_PROVIDERS: "macos", MUSE_MACOS_CALENDAR_NAME: "Home" })).toEqual(["macos"]);
  });
});

describe("buildCalendarRegistry — gcal credential gate (all three required)", () => {
  it("registers when client id, secret, and refresh token are all present", () => {
    expect(ids({ MUSE_CALENDAR_PROVIDERS: "gcal", ...GCAL })).toEqual(["gcal"]);
  });

  it("is skipped when any one credential is missing", () => {
    expect(ids({ MUSE_CALENDAR_PROVIDERS: "gcal", MUSE_GCAL_CLIENT_SECRET: "s", MUSE_GCAL_REFRESH_TOKEN: "r" })).toEqual([]);
    expect(ids({ MUSE_CALENDAR_PROVIDERS: "gcal", MUSE_GCAL_CLIENT_ID: "c", MUSE_GCAL_REFRESH_TOKEN: "r" })).toEqual([]);
    expect(ids({ MUSE_CALENDAR_PROVIDERS: "gcal", MUSE_GCAL_CLIENT_ID: "c", MUSE_GCAL_CLIENT_SECRET: "s" })).toEqual([]);
  });

  it("is skipped without credentials but leaves other providers intact", () => {
    expect(ids({ MUSE_CALENDAR_PROVIDERS: "local,gcal" })).toEqual(["local"]);
  });

  it("resolves credentials from the credentials file (providers.gcal)", async () => {
    await writeCredentials({ gcal: { calendarId: "work@example.com", clientId: "c", clientSecret: "s", refreshToken: "r" } });
    expect(ids({ MUSE_CALENDAR_PROVIDERS: "gcal" })).toEqual(["gcal"]);
  });

  it("registers with the optional calendarId override (default is primary)", () => {
    expect(ids({ MUSE_CALENDAR_PROVIDERS: "gcal", MUSE_GCAL_CALENDAR_ID: "team@example.com", ...GCAL })).toEqual(["gcal"]);
  });
});

describe("buildCalendarRegistry — caldav credential gate (all three required)", () => {
  it("registers when url, username, and password are all present", () => {
    expect(ids({ MUSE_CALENDAR_PROVIDERS: "caldav", ...CALDAV })).toEqual(["caldav"]);
  });

  it("is skipped when any one credential is missing", () => {
    expect(ids({ MUSE_CALENDAR_PROVIDERS: "caldav", MUSE_CALDAV_USERNAME: "n", MUSE_CALDAV_APP_PASSWORD: "p" })).toEqual([]);
    expect(ids({ MUSE_CALENDAR_PROVIDERS: "caldav", MUSE_CALDAV_URL: "u", MUSE_CALDAV_APP_PASSWORD: "p" })).toEqual([]);
    expect(ids({ MUSE_CALENDAR_PROVIDERS: "caldav", MUSE_CALDAV_URL: "u", MUSE_CALDAV_USERNAME: "n" })).toEqual([]);
  });

  it("resolves credentials from the credentials file (providers.caldav)", async () => {
    await writeCredentials({ caldav: { password: "p", url: "u", username: "n" } });
    expect(ids({ MUSE_CALENDAR_PROVIDERS: "caldav" })).toEqual(["caldav"]);
  });
});
