import { describe, expect, it } from "vitest";

import { checkinsFile } from "./commands-checkins.js";

describe("checkinsFile", () => {
  it("honours MUSE_CHECKINS_FILE, else defaults under ~/.muse/checkins.json", () => {
    expect(checkinsFile({ MUSE_CHECKINS_FILE: "/tmp/c.json" } as NodeJS.ProcessEnv)).toBe("/tmp/c.json");
    expect(checkinsFile({} as NodeJS.ProcessEnv).endsWith("/.muse/checkins.json")).toBe(true);
  });
});
