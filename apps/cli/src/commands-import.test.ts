import { describe, expect, it } from "vitest";

import { isSafeMuseEntry } from "./commands-import.js";

describe("isSafeMuseEntry — tarball-restore path safety", () => {
  it("accepts normal files under .muse/", () => {
    expect(isSafeMuseEntry(".muse/tasks.json")).toBe(true);
    expect(isSafeMuseEntry(".muse/notes/daily/2026-05-25.md")).toBe(true);
  });

  it("rejects anything outside the .muse/ prefix", () => {
    expect(isSafeMuseEntry("etc/passwd")).toBe(false);
    expect(isSafeMuseEntry("../.muse/tasks.json")).toBe(false);
    expect(isSafeMuseEntry(".musexyz/x")).toBe(false);
  });

  it("rejects path-traversal segments", () => {
    expect(isSafeMuseEntry(".muse/../etc/passwd")).toBe(false);
    expect(isSafeMuseEntry(".muse/a/../../escape")).toBe(false);
  });

  it("rejects backslashes and directory entries", () => {
    expect(isSafeMuseEntry(".muse/a\\b")).toBe(false);
    expect(isSafeMuseEntry(".muse/sub/")).toBe(false);
  });
});
