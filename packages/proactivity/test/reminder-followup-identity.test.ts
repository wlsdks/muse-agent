import { MUSE_IDENTITY_CORE } from "@muse/prompts";
import { describe, expect, it } from "vitest";

import { FOLLOWUP_SYSTEM_PROMPT } from "../src/followup-firing-loop.js";
import { REMINDER_PHASE_D_SYSTEM_PROMPT } from "../src/reminder-firing-loop.js";

describe("proactivity firing-loop identity", () => {
  it("the reminder heads-up prompt carries the shared identity core plus its own task", () => {
    expect(REMINDER_PHASE_D_SYSTEM_PROMPT).toContain(MUSE_IDENTITY_CORE);
    expect(REMINDER_PHASE_D_SYSTEM_PROMPT).toContain("reminder the");
    expect(REMINDER_PHASE_D_SYSTEM_PROMPT).toContain("just came due");
  });

  it("the followup prompt carries the shared identity core plus its own task", () => {
    expect(FOLLOWUP_SYSTEM_PROMPT).toContain(MUSE_IDENTITY_CORE);
    expect(FOLLOWUP_SYSTEM_PROMPT).toContain("you would follow up");
  });
});
