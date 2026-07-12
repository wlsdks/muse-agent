import { describe, expect, it } from "vitest";

import {
  PERSONAL_WORK_CAPABILITY_PROFILE_ID,
  createToolExposureAuthority,
  isApprovalBindingAllowedForCapabilityProfile,
  isApprovalOperationAllowedForCapabilityProfile,
  isToolAllowedForCapabilityProfile,
  resolveToolExposureAuthority,
  resolveCapabilityProfile,
  selectToolNamesForExposureAuthority,
  selectAllowedToolNames
} from "../src/index.js";

const NON_CODING_BOUNDARY_TOOL_NAMES = [
  "code_write",
  "repository_mutate",
  "shell_execute",
  "process_spawn",
  "runner_execute",
  "test_run",
  "debug_attach",
  "browser_action",
  "remote_mcp_call",
  "outbound_send"
] as const;

describe("personal-work capability profile", () => {
  it("issues an opaque, immutable server authority and rejects forged or serialized copies", () => {
    const callerNames = ["safe.read"];
    const authority = createToolExposureAuthority({
      allowedToolNames: callerNames,
      localMode: true
    });
    callerNames.push("write.after-issue");

    const resolved = resolveToolExposureAuthority(authority);
    expect(resolved).toEqual({ allowedToolNames: ["safe.read"], localMode: true });
    expect(Object.isFrozen(authority)).toBe(true);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved?.allowedToolNames)).toBe(true);

    expect(resolveToolExposureAuthority(null)).toBeUndefined();
    expect(resolveToolExposureAuthority({})).toBeUndefined();
    expect(resolveToolExposureAuthority(JSON.parse(JSON.stringify(authority)))).toBeUndefined();
    expect(resolveToolExposureAuthority({ ...authority })).toBeUndefined();
  });

  it("keeps a profile positive-only when an authority supplies a wider generic list", () => {
    const authority = createToolExposureAuthority({
      allowedToolNames: ["code_write", "shell_execute", "outbound_send"],
      localMode: true,
      profileId: PERSONAL_WORK_CAPABILITY_PROFILE_ID
    });
    const resolved = resolveToolExposureAuthority(authority)!;

    expect(
      selectToolNamesForExposureAuthority(resolved, [
        "code_write",
        "shell_execute",
        "outbound_send"
      ])
    ).toEqual([]);
  });

  it("resolves only the server-registered personal-work profile", () => {
    expect(PERSONAL_WORK_CAPABILITY_PROFILE_ID).toBe("personal-work");

    expect(resolveCapabilityProfile(PERSONAL_WORK_CAPABILITY_PROFILE_ID)).toEqual({
      allowedApprovalOperations: [
        "work.analyze-material",
        "work.draft-artifact",
        "work.apply-local-task"
      ],
      allowedApprovalRisks: ["local-write"],
      allowedToolNames: [],
      allowsRemoteTarget: false,
      id: "personal-work",
      permittedWorkCapabilities: [
        "analyze-user-provided-material",
        "draft-user-reviewable-artifact",
        "apply-user-approved-local-work-item"
      ]
    });
    expect(resolveCapabilityProfile("unknown-profile")).toBeUndefined();
  });

  it("returns a copy so a resolved profile cannot mutate the server registry", () => {
    const resolved = resolveCapabilityProfile(PERSONAL_WORK_CAPABILITY_PROFILE_ID);
    expect(resolved).toBeDefined();

    (resolved!.allowedToolNames as string[]).push("shell_execute");

    expect(resolveCapabilityProfile(PERSONAL_WORK_CAPABILITY_PROFILE_ID)?.allowedToolNames).toEqual([]);
  });

  it("keeps the personal-work profile on an empty positive tool allowlist", () => {
    const profile = resolveCapabilityProfile(PERSONAL_WORK_CAPABILITY_PROFILE_ID)!;

    for (const toolName of NON_CODING_BOUNDARY_TOOL_NAMES) {
      expect(profile.allowedToolNames).not.toContain(toolName);
      expect(isToolAllowedForCapabilityProfile(profile.id, toolName)).toBe(false);
    }
  });

  it("uses an explicit non-coding approval-operation allowlist", () => {
    expect(
      isApprovalOperationAllowedForCapabilityProfile(
        PERSONAL_WORK_CAPABILITY_PROFILE_ID,
        "work.apply-local-task"
      )
    ).toBe(true);

    for (const operation of ["code.write", "repository.mutate", "shell.execute", "test.run", "debug.attach"]) {
      expect(isApprovalOperationAllowedForCapabilityProfile(PERSONAL_WORK_CAPABILITY_PROFILE_ID, operation)).toBe(false);
    }
  });

  it("does not permit an outbound risk or a remote target in the personal-work profile", () => {
    expect(
      isApprovalBindingAllowedForCapabilityProfile(PERSONAL_WORK_CAPABILITY_PROFILE_ID, {
        destination: null,
        host: null,
        operation: "work.apply-local-task",
        risk: "local-write"
      })
    ).toBe(true);

    expect(
      isApprovalBindingAllowedForCapabilityProfile(PERSONAL_WORK_CAPABILITY_PROFILE_ID, {
        destination: null,
        host: null,
        operation: "work.apply-local-task",
        risk: "external-send"
      })
    ).toBe(false);
    expect(
      isApprovalBindingAllowedForCapabilityProfile(PERSONAL_WORK_CAPABILITY_PROFILE_ID, {
        destination: "https://example.test/submit",
        host: "example.test",
        operation: "work.apply-local-task",
        risk: "local-write"
      })
    ).toBe(false);
  });

  it("does not let caller metadata or a supplied allowlist widen server-owned tools", () => {
    const selected = selectAllowedToolNames(
      PERSONAL_WORK_CAPABILITY_PROFILE_ID,
      NON_CODING_BOUNDARY_TOOL_NAMES,
      {
        metadata: { allowedToolNames: [...NON_CODING_BOUNDARY_TOOL_NAMES] },
        requestedToolNames: [...NON_CODING_BOUNDARY_TOOL_NAMES]
      }
    );

    expect(selected).toEqual([]);
  });

  it("fails closed for an unknown profile even when the caller supplies tools", () => {
    expect(
      selectAllowedToolNames("unknown-profile", ["outbound_send"], {
        requestedToolNames: ["outbound_send"]
      })
    ).toEqual([]);
  });
});
