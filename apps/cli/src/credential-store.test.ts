import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultCredentialPath } from "./credential-store.js";

describe("defaultCredentialPath", () => {
  beforeEach(() => {
    vi.stubEnv("HOME", "/u/jinan");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses HOME when set, rooting the credentials file under ~/.config/muse", () => {
    expect(defaultCredentialPath()).toBe("/u/jinan/.config/muse/credentials.json");
  });

  it("honours an explicit non-empty `home` argument over HOME (trimmed)", () => {
    expect(defaultCredentialPath("/elsewhere")).toBe("/elsewhere/.config/muse/credentials.json");
    expect(defaultCredentialPath("  /trimmed  ")).toBe("/trimmed/.config/muse/credentials.json");
  });

  it("treats an empty / whitespace-only explicit `home` argument as unset and falls through to HOME", () => {
    expect(defaultCredentialPath("")).toBe("/u/jinan/.config/muse/credentials.json");
    expect(defaultCredentialPath("   ")).toBe("/u/jinan/.config/muse/credentials.json");
  });

  it("FAILS LOUD when HOME and os.homedir() both resolve to empty — credentials must NOT silently land at /.config/muse/... at the filesystem root", () => {
    vi.stubEnv("HOME", "");
    // On systems where stubbing HOME="" also makes os.homedir() return "",
    // the resolver MUST throw rather than write to `/.config/muse/...`.
    // Otherwise (homedir() finds a real home via getpwuid), the result
    // must root under that home, never under "/".
    try {
      const path = defaultCredentialPath();
      expect(path).not.toMatch(/^\/\.config\/muse/u);
      expect(path).toMatch(/\/.config\/muse\/credentials\.json$/u);
    } catch (cause) {
      expect((cause as Error).message).toMatch(/Cannot resolve home directory/u);
    }
  });
});
