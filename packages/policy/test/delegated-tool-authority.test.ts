import { describe, expect, it } from "vitest";

import {
  attenuateToolExposureAuthority,
  createToolExposureAuthority,
  PERSONAL_WORK_CAPABILITY_PROFILE_ID,
  resolveToolExposureAuthority
} from "../src/index.js";

describe("attenuateToolExposureAuthority", () => {
  it("narrows genuine authority and represents an undefined-parent child list as an opaque safe-default ceiling", () => {
    const parent = createToolExposureAuthority({
      allowedToolNames: ["safe.read", "tasks.write"],
      localMode: true,
      profileId: PERSONAL_WORK_CAPABILITY_PROFILE_ID
    });

    expect(resolveToolExposureAuthority(attenuateToolExposureAuthority(parent, undefined))).toEqual({
      allowedToolNames: ["safe.read", "tasks.write"],
      localMode: true,
      profileId: PERSONAL_WORK_CAPABILITY_PROFILE_ID
    });
    expect(resolveToolExposureAuthority(attenuateToolExposureAuthority(parent, ["tasks.write", "forbidden"]))).toEqual({
      allowedToolNames: ["tasks.write"],
      localMode: true,
      profileId: PERSONAL_WORK_CAPABILITY_PROFILE_ID
    });
    expect(resolveToolExposureAuthority(attenuateToolExposureAuthority(parent, []))?.allowedToolNames).toEqual([]);

    expect(attenuateToolExposureAuthority(undefined, undefined)).toBeUndefined();
    const safeDefault = attenuateToolExposureAuthority(undefined, ["safe.read", "tasks.write", "local.read"]);
    expect(resolveToolExposureAuthority(safeDefault)).toEqual({
      allowedToolNames: ["safe.read", "tasks.write", "local.read"],
      localMode: false,
      safeDefaultOnly: true
    });
    expect(resolveToolExposureAuthority(attenuateToolExposureAuthority(safeDefault, ["safe.read", "forbidden"]))).toEqual({
      allowedToolNames: ["safe.read"],
      localMode: false,
      safeDefaultOnly: true
    });
    expect(resolveToolExposureAuthority(attenuateToolExposureAuthority(undefined, []))).toEqual({
      allowedToolNames: [],
      localMode: false
    });
    for (const forged of [null, {}, JSON.parse(JSON.stringify(parent))]) {
      expect(resolveToolExposureAuthority(attenuateToolExposureAuthority(forged, ["safe.read"]))).toEqual({
        allowedToolNames: [],
        localMode: false
      });
    }
  });
});
