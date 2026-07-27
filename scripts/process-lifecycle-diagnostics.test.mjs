import assert from "node:assert/strict";
import test from "node:test";

import {
  matchesProcessIdentity,
  parseLifecycleDiagnosticOutput,
  parseProcessTable,
  selectProcessAncestry,
  summarizeActiveResources
} from "./lib/process-lifecycle-diagnostics.mjs";

test("diagnostic output parser waits for a complete newline-delimited receipt", () => {
  const partial = '10 passed, 0 failed\nsmoke:cli lifecycle {"rootPid":123';
  assert.equal(parseLifecycleDiagnosticOutput(partial), undefined);
  assert.deepEqual(
    parseLifecycleDiagnosticOutput(`${partial}}\n`),
    { rootPid: 123 }
  );
  assert.throws(
    () => parseLifecycleDiagnosticOutput("smoke:cli lifecycle {not-json}\n"),
    SyntaxError
  );
});

test("active resource summaries expose stable state but no endpoint or payload fields", () => {
  class Socket {
    constructor() {
      this.connecting = false;
      this.destroyed = false;
      this.readable = true;
      this.writable = true;
      this.remoteAddress = "203.0.113.9";
      this.remotePort = 443;
      this.payload = "secret";
    }

    hasRef() {
      return true;
    }
  }

  class ChildProcess {
    constructor() {
      this.exitCode = null;
      this.killed = false;
      this.pid = 4321;
      this.signalCode = null;
      this.spawnargs = ["node", "--token=secret"];
    }
  }

  const summary = summarizeActiveResources({
    handles: [new Socket(), new ChildProcess()],
    requests: [{ constructor: { name: "TCPConnectWrap" }, endpoint: "private.example" }]
  });

  assert.deepEqual(summary, {
    handles: [
      {
        connecting: false,
        destroyed: false,
        hasRef: true,
        readable: true,
        type: "Socket",
        writable: true
      },
      {
        exitCode: null,
        killed: false,
        pid: 4321,
        signalCode: null,
        type: "ChildProcess"
      }
    ],
    requests: [{ type: "TCPConnectWrap" }]
  });
  assert.equal(JSON.stringify(summary).includes("secret"), false);
  assert.equal(JSON.stringify(summary).includes("203.0.113.9"), false);
  assert.equal(JSON.stringify(summary).includes("private.example"), false);
});

test("process table parser keeps exact identity fields and drops argv", () => {
  const records = parseProcessTable(
    [
      " 100  1 100 Mon Jul 27 13:00:00 2026 /usr/local/bin/node",
      " 101 100 100 Mon Jul 27 13:00:01 2026 /opt/homebrew/bin/pnpm",
      " 102 101 100 Mon Jul 27 13:00:02 2026 npm exec server --token=secret",
      "malformed --token=secret"
    ].join("\n")
  );

  assert.deepEqual(records, [
    {
      executable: "/usr/local/bin/node",
      osStartedAt: "Mon Jul 27 13:00:00 2026",
      parentPid: 1,
      pid: 100,
      processGroupId: 100
    },
    {
      executable: "/opt/homebrew/bin/pnpm",
      osStartedAt: "Mon Jul 27 13:00:01 2026",
      parentPid: 100,
      pid: 101,
      processGroupId: 100
    },
    {
      executable: "npm",
      osStartedAt: "Mon Jul 27 13:00:02 2026",
      parentPid: 101,
      pid: 102,
      processGroupId: 100
    }
  ]);
  assert.equal(JSON.stringify(records).includes("secret"), false);
});

test("ancestry selects descendants and exact process-group members without name guessing", () => {
  const records = [
    { executable: "/node", osStartedAt: "root", parentPid: 1, pid: 100, processGroupId: 100 },
    { executable: "/pnpm", osStartedAt: "child", parentPid: 100, pid: 101, processGroupId: 100 },
    { executable: "/node", osStartedAt: "grandchild", parentPid: 101, pid: 102, processGroupId: 100 },
    { executable: "/orphan", osStartedAt: "orphan", parentPid: 1, pid: 103, processGroupId: 100 },
    { executable: "/unrelated-node", osStartedAt: "other", parentPid: 1, pid: 104, processGroupId: 104 }
  ];

  assert.deepEqual(selectProcessAncestry(records, { processGroupId: 100, rootPid: 100 }), [
    { ...records[0], lineage: [100], relationship: "root" },
    { ...records[1], lineage: [100, 101], relationship: "descendant" },
    { ...records[2], lineage: [100, 101, 102], relationship: "descendant" },
    { ...records[3], lineage: [103], relationship: "process-group-member" }
  ]);
});

test("process identity matching fails closed on PID reuse or group drift", () => {
  const receipt = {
    executable: "/usr/local/bin/node",
    osStartedAt: "Mon Jul 27 13:00:00 2026",
    pid: 100,
    processGroupId: 100
  };
  assert.equal(matchesProcessIdentity(receipt, { ...receipt }), true);
  assert.equal(matchesProcessIdentity(receipt, { ...receipt, osStartedAt: "Mon Jul 27 13:05:00 2026" }), false);
  assert.equal(matchesProcessIdentity(receipt, { ...receipt, processGroupId: 99 }), false);
  assert.equal(matchesProcessIdentity(receipt, undefined), false);
});
