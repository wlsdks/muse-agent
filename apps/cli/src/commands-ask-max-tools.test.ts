import { resolveToolExposureAuthority } from "@muse/policy";
import { afterEach, describe, expect, it } from "vitest";

import {
  createTrustedAskToolExposureAuthority,
  TRUSTED_CLI_PERSONAL_READ_MAX_TOOLS,
  TRUSTED_CLI_PERSONAL_READ_TOOL_ALLOWLIST
} from "./trusted-local-cli-authority.js";

const originalAskMaxTools = process.env.MUSE_ASK_MAX_TOOLS;

afterEach(() => {
  if (originalAskMaxTools === undefined) {
    delete process.env.MUSE_ASK_MAX_TOOLS;
  } else {
    process.env.MUSE_ASK_MAX_TOOLS = originalAskMaxTools;
  }
});

describe("muse ask trusted tool cap", () => {
  it("uses the code-owned cap of seven", () => {
    expect(TRUSTED_CLI_PERSONAL_READ_MAX_TOOLS).toBe(7);
  });

  it.each(["0", "off", "999", "many", "-3"])("does not let MUSE_ASK_MAX_TOOLS=%s alter the static authority", (value) => {
    process.env.MUSE_ASK_MAX_TOOLS = value;
    const authority = resolveToolExposureAuthority(createTrustedAskToolExposureAuthority());

    expect(TRUSTED_CLI_PERSONAL_READ_MAX_TOOLS).toBe(7);
    expect(authority).toEqual({
      allowedToolNames: TRUSTED_CLI_PERSONAL_READ_TOOL_ALLOWLIST,
      localMode: false
    });
  });
});
