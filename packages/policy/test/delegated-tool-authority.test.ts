import { describe, expect, it } from "vitest";
import { resolve, sep } from "node:path";

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

  it("intersects delegated write paths, keeps the earliest expiry, and rejects expired or forged authority", () => {
    const parent = createToolExposureAuthority({
      allowedToolNames: ["file_write", "file_read"],
      expiresAt: "2099-08-01T00:00:00.000Z",
      localMode: true,
      writablePaths: ["/workspace/reports"]
    });
    const delegated = attenuateToolExposureAuthority(
      parent,
      ["file_write"],
      {
        expiresAt: "2099-07-30T00:00:00.000Z",
        writablePaths: ["/workspace/reports/a", "/workspace/outside"]
      }
    );
    expect(resolveToolExposureAuthority(delegated)).toEqual({
      allowedToolNames: ["file_write"],
      expiresAt: "2099-07-30T00:00:00.000Z",
      localMode: true,
      writablePaths: ["/workspace/reports/a"]
    });
    expect(resolveToolExposureAuthority(attenuateToolExposureAuthority({}, ["file_write"], {
      expiresAt: "2099-07-30T00:00:00.000Z",
      writablePaths: ["/workspace/reports/a"]
    }))).toEqual({ allowedToolNames: [], localMode: false });
    expect(resolveToolExposureAuthority(createToolExposureAuthority({
      allowedToolNames: ["file_write"],
      expiresAt: "2000-01-01T00:00:00.000Z",
      localMode: true
    }))).toBeUndefined();

    for (const scope of [
      { expiresAt: "not-a-time", writablePaths: ["/workspace/reports/a"] },
      { expiresAt: "2099-07-30T00:00:00.000Z", writablePaths: ["relative/path"] },
      { expiresAt: "2099-07-30T00:00:00.000Z", writablePaths: ["/workspace/reports/../outside"] },
      { expiresAt: "2099-07-30T00:00:00.000Z", writablePaths: ["/workspace/reports\\alias"] }
    ]) {
      expect(resolveToolExposureAuthority(
        attenuateToolExposureAuthority(parent, ["file_write"], scope)
      )?.allowedToolNames).toEqual([]);
    }

    const parentEarlier = createToolExposureAuthority({
      allowedToolNames: ["file_write"],
      expiresAt: "2099-07-01T00:00:00.000Z",
      localMode: true,
      writablePaths: ["/workspace/reports/a"]
    });
    expect(resolveToolExposureAuthority(attenuateToolExposureAuthority(parentEarlier, ["file_write"], {
      expiresAt: "2099-07-30T00:00:00.000Z",
      writablePaths: ["/workspace/reports/a"]
    }))?.expiresAt).toBe("2099-07-01T00:00:00.000Z");

    const caseParentPath = resolve(process.cwd(), "Reports");
    const caseChildPath = resolve(process.cwd(), "reports", "a");
    const caseDistinct = attenuateToolExposureAuthority(
      createToolExposureAuthority({
        allowedToolNames: ["file_write"],
        localMode: true,
        writablePaths: [caseParentPath]
      }),
      ["file_write"],
      {
        expiresAt: "2099-07-30T00:00:00.000Z",
        writablePaths: [caseChildPath]
      }
    );
    expect(resolveToolExposureAuthority(caseDistinct)?.writablePaths).toEqual(
      sep === "\\" ? [caseChildPath] : []
    );
  });
});
