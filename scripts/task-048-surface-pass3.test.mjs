import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateSurfacePass3,
  parseBrowserSmokeOutput,
  parseCliSmokeOutput,
  parsePersonalAgentE2eOutput,
  parsePlaywrightQualificationReport,
  projectCleanProcessReport
} from "./lib/task-048-surface-pass3.mjs";

test("Playwright qualification accepts exactly two expected tests with no skip or unexpected outcome", () => {
  assert.deepEqual(
    parsePlaywrightQualificationReport({
      errors: [],
      stats: {
        duration: 12_345,
        expected: 2,
        flaky: 0,
        skipped: 0,
        startTime: "2026-07-27T00:00:00.000Z",
        unexpected: 0
      },
      suites: []
    }, 2),
    {
      durationMs: 12_345,
      expected: 2,
      flaky: 0,
      skipped: 0,
      unexpected: 0
    }
  );
});

test("Playwright qualification fails closed on skip, flake, or test-count drift", () => {
  for (const stats of [
    { duration: 1, expected: 1, flaky: 0, skipped: 0, unexpected: 0 },
    { duration: 1, expected: 2, flaky: 0, skipped: 1, unexpected: 0 },
    { duration: 1, expected: 2, flaky: 1, skipped: 0, unexpected: 0 },
    { duration: 1, expected: 2, flaky: 0, skipped: 0, unexpected: 1 }
  ]) {
    assert.throws(
      () => parsePlaywrightQualificationReport({ errors: [], stats }, 2),
      /exact no-skip pass/u
    );
  }
});

test("Browser smoke parser requires PASS plus exact owned process, port, and profile diagnostics", () => {
  const receipt = {
    executablePath: "/Applications/Chromium.app/Contents/MacOS/Chromium",
    launchId: "browser-launch-1",
    osStartedAt: "2026-07-27T00:00:00.000Z",
    pid: 1001,
    processGroupId: 1001,
    userDataDir: "/tmp/muse-browser-smoke-a/profile"
  };
  const diagnostic = {
    browserReceipts: [receipt],
    ports: [{ name: "status-http", port: 45_123 }],
    profiles: [receipt.userDataDir],
    tempRoot: "/tmp/muse-browser-smoke-a",
    type: "browser-smoke-owned-state"
  };
  const output = [
    `smoke:browser qualification ${JSON.stringify(diagnostic)}`,
    "smoke:browser PASS",
    ""
  ].join("\n");

  assert.deepEqual(parseBrowserSmokeOutput(output), diagnostic);
});

test("Browser smoke parser rejects Chrome skip even when the command exits zero", () => {
  assert.throws(
    () => parseBrowserSmokeOutput("SKIP: Chrome unavailable\n"),
    /explicit no-skip PASS/u
  );
});

test("CLI smoke parser requires exact 10/10 summary and owned API port diagnostics", () => {
  const owned = {
    apiPort: 46_234,
    apiReceipt: {
      executable: "/usr/local/bin/node",
      osStartedAt: "Sun Jul 27 09:00:00 2026",
      pid: 2001,
      processGroupId: 2001
    },
    rootPid: 2000,
    schedulerRoot: "/tmp/muse-smoke-cli-scheduler-a"
  };
  const lifecycle = {
    activeResources: { handles: [], requests: [] },
    processGroupId: 2000,
    processes: [{ pid: 2000, relationship: "root" }],
    rootPid: 2000,
    schedulerRoot: owned.schedulerRoot,
    stage: "post-shutdown"
  };
  const output = [
    `smoke:cli lifecycle-owned ${JSON.stringify(owned)}`,
    "10 passed, 0 failed",
    `smoke:cli lifecycle ${JSON.stringify(lifecycle)}`,
    ""
  ].join("\n");

  assert.deepEqual(parseCliSmokeOutput(output), { lifecycle, owned });
});

test("CLI smoke parser rejects a post-summary descendant process", () => {
  const owned = {
    apiPort: 46_234,
    apiReceipt: {
      osStartedAt: "Sun Jul 27 09:00:00 2026",
      pid: 2001,
      processGroupId: 2001
    },
    rootPid: 2000,
    schedulerRoot: "/tmp/muse-smoke-cli-scheduler-a"
  };
  const lifecycle = {
    processes: [
      { pid: 2000, relationship: "root" },
      { pid: 2001, relationship: "descendant" }
    ],
    rootPid: 2000,
    schedulerRoot: owned.schedulerRoot,
    stage: "post-shutdown"
  };
  assert.throws(
    () => parseCliSmokeOutput([
      `smoke:cli lifecycle-owned ${JSON.stringify(owned)}`,
      "10 passed, 0 failed",
      `smoke:cli lifecycle ${JSON.stringify(lifecycle)}`
    ].join("\n")),
    /not clean/u
  );
});

test("personal-agent E2E parser binds exact Playwright counts to one owned API/Web run", () => {
  const ownedState = {
    apiUrl: "http://127.0.0.1:47001",
    embedUrl: "http://127.0.0.1:47003",
    playwrightReceipt: {
      executable: "/usr/local/bin/node",
      osStartedAt: "Sun Jul 27 09:10:00 2026",
      pid: 3001,
      processGroupId: 3001
    },
    stateRoot: "/tmp/muse-personal-agent-e2e-a",
    type: "personal-agent-e2e-owned-state",
    webUrl: "http://127.0.0.1:47002"
  };
  const qualification = {
    playwright: {
      durationMs: 8_765,
      expected: 2,
      flaky: 0,
      skipped: 0,
      unexpected: 0
    },
    runId: "task048-e2e-1",
    type: "personal-agent-e2e-qualification"
  };
  const output = [
    JSON.stringify(ownedState),
    JSON.stringify(qualification),
    "personal-agent E2E fixture PASS (local-only, persisted, residue 0)",
    ""
  ].join("\n");

  assert.deepEqual(parsePersonalAgentE2eOutput(output, 2), { ownedState, qualification });
});

test("clean-process projection accepts only a bounded no-skip exit with zero exact residue", () => {
  const input = {
    finishedAt: "2026-07-27T00:00:10.000Z",
    noSkip: true,
    provenance: { kind: "browser-smoke", runId: "task048-browser-1" },
    resources: {
      ownedProcessResidue: 0,
      ports: [{ closed: true, name: "status-http", port: 45_123 }],
      profileResidue: 0,
      tempResidue: 0
    },
    runId: "task048-browser-1",
    startedAt: "2026-07-27T00:00:00.000Z",
    surface: "browser",
    terminal: {
      bounded: true,
      exitCode: 0,
      signal: null,
      timedOut: false,
      timeoutMs: 600_000
    },
    trial: 1
  };

  assert.deepEqual(projectCleanProcessReport(input), {
    ...input,
    result: "pass",
    schemaVersion: "muse.personal-agent.surface-clean-process-report/v1"
  });
});

test("aggregate requires exactly 3/3 reports per surface with API and Web sharing each E2E run", () => {
  const reports = completeReports();

  assert.deepEqual(aggregateSurfacePass3({
    inputHashEnd: "b".repeat(64),
    inputHashStart: "b".repeat(64),
    reports,
    source: { endHead: "a".repeat(40), startHead: "a".repeat(40) }
  }), {
    reasons: [],
    result: "pass",
    surfaces: {
      api: { passed: 3, required: 3 },
      browser: { passed: 3, required: 3 },
      cli: { passed: 3, required: 3 },
      web: { passed: 3, required: 3 }
    }
  });
});

test("aggregate fails closed when a nominal pass report contains residue", () => {
  const reports = completeReports();
  const browser = reports.find((report) => report.surface === "browser" && report.trial === 2);
  browser.resources = { ...browser.resources, tempResidue: 1 };

  const aggregate = aggregateSurfacePass3({
    inputHashEnd: "b".repeat(64),
    inputHashStart: "b".repeat(64),
    reports,
    source: { endHead: "a".repeat(40), startHead: "a".repeat(40) }
  });
  assert.equal(aggregate.result, "fail");
  assert.ok(aggregate.reasons.includes("browser-pass-count"));
});

function completeReports() {
  const reports = [];
  for (let trial = 1; trial <= 3; trial += 1) {
    reports.push(cleanReport("browser", trial, `browser-${trial.toString()}`));
    reports.push(cleanReport("cli", trial, `cli-${trial.toString()}`));
    const sharedRunId = `e2e-${trial.toString()}`;
    const shared = {
      kind: "personal-agent-e2e",
      runId: sharedRunId,
      sharedSurfaces: ["api", "web"]
    };
    reports.push(cleanReport("api", trial, sharedRunId, shared));
    reports.push(cleanReport("web", trial, sharedRunId, shared));
  }
  return reports;
}

function cleanReport(surface, trial, runId, provenance = { kind: `${surface}-smoke`, runId }) {
  return projectCleanProcessReport({
    finishedAt: `2026-07-27T00:00:0${trial.toString()}.000Z`,
    noSkip: true,
    provenance,
    resources: {
      ownedProcessResidue: 0,
      ports: [{ closed: true, name: `${surface}-port`, port: 40_000 + trial }],
      profileResidue: 0,
      tempResidue: 0
    },
    runId,
    startedAt: "2026-07-27T00:00:00.000Z",
    surface,
    terminal: {
      bounded: true,
      exitCode: 0,
      signal: null,
      timedOut: false,
      timeoutMs: 600_000
    },
    trial
  });
}
