import { expect, expectTypeOf, it } from "vitest";

import type { AttuneGraphExecuteCommand } from "@attunegraph/core";
import * as admin from "@attunegraph/core/admin";
import * as readonlyWorkingGraph from "@attunegraph/core/readonly-working-graph";
import type {
  AttuneGraphAdminErrorCode,
  AttuneGraphAdminHeadResult,
  AttuneGraphAdminReadonlyApplication,
  AttuneGraphAdminStoreSummary,
  AttuneGraphScope,
  OpenAttuneGraphAdminReadonlyApplicationOptions
} from "@attunegraph/core/admin";
import type {
  ReadLocalAttuneGraphWorkingGraphOptions
} from "@attunegraph/core/readonly-working-graph";

it("exposes the exact production readonly Admin runtime allowlist", () => {
  expect(Object.keys(admin).sort()).toEqual([
    "AttuneGraphAdminReadonlyError",
    "openAttuneGraphAdminReadonlyApplication"
  ]);
});

it("exposes one capability-narrow readonly Working Graph runtime", () => {
  expect(Object.keys(readonlyWorkingGraph)).toEqual([
    "readLocalAttuneGraphWorkingGraph"
  ]);
  expectTypeOf<ReadLocalAttuneGraphWorkingGraphOptions>().toEqualTypeOf<{
    readonly command: AttuneGraphExecuteCommand;
    readonly databasePath: string;
    readonly scope: AttuneGraphScope;
  }>();
});

it("exposes the closed standalone Admin type contract", () => {
  expectTypeOf<OpenAttuneGraphAdminReadonlyApplicationOptions>().toEqualTypeOf<{
    readonly databasePath: string;
    readonly sourceState: "closed-quiescent";
  }>();
  expectTypeOf<AttuneGraphScope>().toEqualTypeOf<{
    readonly sourceId: string;
    readonly threadId: string;
  }>();
  expectTypeOf<AttuneGraphAdminReadonlyApplication["inspectSummary"]>()
    .returns.toEqualTypeOf<Promise<AttuneGraphAdminStoreSummary>>();
  expectTypeOf<AttuneGraphAdminReadonlyApplication["inspectHead"]>()
    .returns.toEqualTypeOf<Promise<AttuneGraphAdminHeadResult>>();
  expectTypeOf<AttuneGraphAdminErrorCode>().toEqualTypeOf<
    | "INVALID_INPUT"
    | "INVALID_STATE"
    | "REENTRY"
    | "SOURCE_NOT_FOUND"
    | "UNSUPPORTED_PROFILE"
    | "CORRUPT_STORE"
    | "FUTURE_STORE_STATE"
    | "STORE_BUSY"
    | "TIMED_OUT"
    | "WORKER_FAILURE"
  >();
});

it("keeps qualification and private Admin Modules unreachable", async () => {
  for (const name of [
    "startAttuneGraphAdminReadonlyApplicationQualification",
    "openAttuneGraphAdminReadonlySpine",
    "acquireAttuneGraphAdminReadonlySnapshot",
    "createAttuneGraphAdminReadOnlyInspector",
    "AdminWorkerTransport",
    "AdminClockForQualification",
    "ApplicationQualificationAudit"
  ]) {
    expect(Object.hasOwn(admin, name)).toBe(false);
  }

  for (const privateSubpath of [
    "@attunegraph/core/attunegraph-admin-readonly-application",
    "@attunegraph/core/attunegraph-admin-readonly-spine",
    "@attunegraph/core/attunegraph-admin-readonly-snapshot",
    "@attunegraph/core/attunegraph-admin-readonly-inspector",
    "@attunegraph/core/attunegraph-admin-readonly-worker"
  ]) {
    await expect(import(privateSubpath)).rejects.toThrow(/not exported/u);
  }
});
