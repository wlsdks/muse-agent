import { mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FileCalendarCredentialStore } from "../src/index.js";

function freshFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-cal-creds-")), "credentials.json");
}

describe("FileCalendarCredentialStore", () => {
  it("returns undefined / empty for a missing file (tolerant first read, no throw)", async () => {
    const store = new FileCalendarCredentialStore(freshFile());
    expect(await store.load("google")).toBeUndefined();
    expect(await store.list()).toEqual([]);
    await expect(store.remove("google")).resolves.toBeUndefined();
  });

  it("round-trips save / load / list / remove and deep-copies (no aliasing into the store)", async () => {
    const store = new FileCalendarCredentialStore(freshFile());
    const creds = { refreshToken: "rt-1" };
    await store.save("google", creds);
    await store.save("caldav", { password: "p" });
    creds.refreshToken = "MUTATED";
    expect(await store.load("google")).toEqual({ refreshToken: "rt-1" });
    const loaded = (await store.load("google"))!;
    (loaded as { refreshToken: string }).refreshToken = "MUTATED-2";
    expect(await store.load("google")).toEqual({ refreshToken: "rt-1" });
    expect(await store.list()).toEqual(["caldav", "google"]);
    await store.remove("google");
    expect(await store.list()).toEqual(["caldav"]);
    expect(await store.load("google")).toBeUndefined();
  });

  it("QUARANTINES a corrupt credentials file instead of silently wiping it", async () => {
    const file = freshFile();
    writeFileSync(file, "{ broken json", "utf8"); // a half-written / corrupted store
    const store = new FileCalendarCredentialStore(file);
    // degrades to empty so the app keeps working…
    expect(await store.list()).toEqual([]);
    expect(await store.load("google")).toBeUndefined();
    // …but the original bytes survive at a `<file>.corrupt-*` sibling — NOT lost.
    const siblings = readdirSync(join(file, "..")).filter((n) => n.includes("credentials.json.corrupt-"));
    expect(siblings).toHaveLength(1);
  });

  it("persists with file mode 0600 and leaves no .tmp- sibling", async () => {
    if (process.platform === "win32") {
      return; // POSIX mode bits are meaningless on Windows.
    }
    const file = freshFile();
    const store = new FileCalendarCredentialStore(file);
    await store.save("google", { refreshToken: "secret-oauth-refresh" });
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    const siblings = readdirSync(join(file, "..")).filter((n) => n.includes(".tmp-"));
    expect(siblings).toEqual([]);
  });

  it("tolerates a corrupt / wrong-shape credentials file instead of crashing the calendar stack", async () => {
    const file = freshFile();
    writeFileSync(file, "{ this is not json");
    const corrupt = new FileCalendarCredentialStore(file);
    expect(await corrupt.list()).toEqual([]);
    expect(await corrupt.load("google")).toBeUndefined();
    // A read tolerantly recovers: a subsequent save rewrites cleanly.
    await corrupt.save("google", { refreshToken: "rt" });
    expect(await corrupt.load("google")).toEqual({ refreshToken: "rt" });

    const wrongShape = freshFile();
    writeFileSync(wrongShape, JSON.stringify({ providers: "not-an-object" }));
    const ws = new FileCalendarCredentialStore(wrongShape);
    expect(await ws.list()).toEqual([]);
  });

  it("is prototype-safe: a providerId like __proto__ / toString never false-hits Object.prototype", async () => {
    const store = new FileCalendarCredentialStore(freshFile());
    // Fresh store: these must be undefined, NOT a bogus inherited {}.
    expect(await store.load("__proto__")).toBeUndefined();
    expect(await store.load("toString")).toBeUndefined();
    expect(await store.load("constructor")).toBeUndefined();
    // And they round-trip as ordinary keys without polluting siblings.
    await store.save("__proto__", { token: "x" });
    expect(await store.load("__proto__")).toEqual({ token: "x" });
    expect(await store.load("toString")).toBeUndefined();
    expect(await store.list()).toEqual(["__proto__"]);
  });
});
