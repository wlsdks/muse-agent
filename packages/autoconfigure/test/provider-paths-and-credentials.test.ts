import { mkdtempSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveCheckinsFile, resolveInboxInjectionCursorFile, resolveRecallHitsFile } from "../src/provider-paths.js";
import { readCredentialsSync } from "../src/provider-utils.js";

// resolveDotMusePath (shared by every resolve*File): an env override wins (with
// leading-tilde expansion), else ~/.muse/<default>. A blank/whitespace override
// must NOT win — it falls back to the default, so a cleared env var can't point
// the store at the cwd-relative empty path.
describe("provider-paths resolvers (resolveDotMusePath)", () => {
  const isolatedHome = mkdtempSync(join(tmpdir(), "muse-provider-paths-home-"));

  it("defaults to ~/.muse/<name> when the env override is unset", () => {
    expect(resolveRecallHitsFile({ HOME: isolatedHome })).toBe(join(isolatedHome, ".muse", "recall-hits.json"));
    expect(resolveCheckinsFile({ HOME: isolatedHome })).toBe(join(isolatedHome, ".muse", "checkins.json"));
  });

  it("honours an absolute env override verbatim", () => {
    const override = join(isolatedHome, "custom", "hits.json");
    expect(resolveRecallHitsFile({ HOME: isolatedHome, MUSE_RECALL_HITS_FILE: override })).toBe(override);
  });

  it("expands a leading ~ in the env override to the home directory", () => {
    expect(resolveRecallHitsFile({ MUSE_RECALL_HITS_FILE: "~/notes/hits.json" })).toBe(join(homedir(), "notes/hits.json"));
  });

  it("treats a blank / whitespace override as unset and falls back to the default", () => {
    expect(resolveCheckinsFile({ HOME: isolatedHome, MUSE_CHECKINS_FILE: "   " })).toBe(join(isolatedHome, ".muse", "checkins.json"));
  });

  it("keeps inbox cursor provider IDs inside the dot-muse path", () => {
    expect(resolveInboxInjectionCursorFile({ HOME: isolatedHome }, "telegram"))
      .toBe(join(isolatedHome, ".muse", "telegram-inbox-injection.json"));
    expect(() => resolveInboxInjectionCursorFile({ HOME: isolatedHome }, "../../outside"))
      .toThrow("providerId must contain only letters, numbers, underscores, or hyphens");
  });
});

describe("readCredentialsSync", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "muse-cred-")); });
  afterEach(async () => { await rm(dir, { force: true, recursive: true }); });

  it("returns the providers map from a well-formed store", async () => {
    const file = join(dir, "creds.json");
    await writeFile(file, JSON.stringify({ providers: { anthropic: { apiKey: "y" }, openai: { apiKey: "x" } } }));
    expect(readCredentialsSync(file)).toEqual({ anthropic: { apiKey: "y" }, openai: { apiKey: "x" } });
  });

  it("degrades to {} for a missing file, malformed JSON, or a missing / non-object providers field", async () => {
    expect(readCredentialsSync(join(dir, "absent.json"))).toEqual({});
    const bad = join(dir, "bad.json"); await writeFile(bad, "{not json");
    expect(readCredentialsSync(bad)).toEqual({});
    const noProviders = join(dir, "np.json"); await writeFile(noProviders, JSON.stringify({ other: 1 }));
    expect(readCredentialsSync(noProviders)).toEqual({});
    const nonObject = join(dir, "ns.json"); await writeFile(nonObject, JSON.stringify({ providers: "nope" }));
    expect(readCredentialsSync(nonObject)).toEqual({});
  });
});
