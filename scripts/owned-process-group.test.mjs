import assert from "node:assert/strict";
import test from "node:test";

import {
  bindOwnedProcessGroup,
  forceOwnedProcessGroup,
  OwnedProcessGroupOwnershipMismatchError,
  OwnedProcessGroupStillRunningError,
  ownedProcessGroupMembers,
  signalOwnedProcessRoot,
  waitForOwnedProcessGroupExit
} from "./lib/owned-process-group.mjs";

const receipt = Object.freeze({
  executable: "/opt/homebrew/bin/node",
  osStartedAt: "Sun Jul 27 10:00:00 2026",
  parentPid: 101,
  pid: 4242,
  processGroupId: 4242
});
const member = Object.freeze({
  executable: "/opt/homebrew/bin/node",
  osStartedAt: "Sun Jul 27 10:00:01 2026",
  parentPid: receipt.pid,
  pid: 4243,
  processGroupId: receipt.processGroupId
});

test("binds only an observed child that leads its exact process group", async () => {
  assert.deepEqual(
    await bindOwnedProcessGroup(receipt.pid, { readProcesses: async () => [receipt] }),
    receipt
  );
  await assert.rejects(
    bindOwnedProcessGroup(receipt.pid, {
      readProcesses: async () => [{ ...receipt, processGroupId: 99 }]
    }),
    OwnedProcessGroupOwnershipMismatchError
  );
});

test("graceful signalling targets the exact root PID only", async () => {
  const signals = [];
  assert.equal(await signalOwnedProcessRoot(receipt, "SIGTERM", {
    readProcesses: async () => [receipt, member],
    signalProcess: (pid, signal) => signals.push({ pid, signal })
  }), "signalled");
  assert.deepEqual(signals, [{ pid: receipt.pid, signal: "SIGTERM" }]);
});

test("forced signalling targets only the exact owned process group", async () => {
  const signals = [];
  assert.equal(await forceOwnedProcessGroup(receipt, "SIGKILL", {
    readProcesses: async () => [receipt, member],
    signalProcessGroup: (processGroupId, signal) => signals.push({ processGroupId, signal })
  }), "signalled");
  assert.deepEqual(signals, [{ processGroupId: receipt.processGroupId, signal: "SIGKILL" }]);
});

test("identity replacement rejects every signal and group observation", async () => {
  const replacement = { ...receipt, osStartedAt: "Sun Jul 27 10:00:02 2026" };
  let signalCount = 0;
  await assert.rejects(
    signalOwnedProcessRoot(receipt, "SIGTERM", {
      readProcesses: async () => [replacement],
      signalProcess: () => {
        signalCount += 1;
      }
    }),
    OwnedProcessGroupOwnershipMismatchError
  );
  await assert.rejects(
    forceOwnedProcessGroup(receipt, "SIGKILL", {
      readProcesses: async () => [replacement],
      signalProcessGroup: () => {
        signalCount += 1;
      }
    }),
    OwnedProcessGroupOwnershipMismatchError
  );
  await assert.rejects(
    ownedProcessGroupMembers(receipt, { readProcesses: async () => [replacement] }),
    OwnedProcessGroupOwnershipMismatchError
  );
  assert.equal(signalCount, 0);
});

test("macOS zombie command decoration preserves the exact birth identity only", async () => {
  const zombie = { ...receipt, executable: "(node)" };
  assert.equal(await signalOwnedProcessRoot(receipt, "SIGTERM", {
    readProcesses: async () => [zombie],
    signalProcess: () => {}
  }), "signalled");
  await assert.rejects(
    signalOwnedProcessRoot(receipt, "SIGTERM", {
      readProcesses: async () => [{ ...zombie, osStartedAt: "Sun Jul 27 10:00:01 2026" }],
      signalProcess: () => {}
    }),
    OwnedProcessGroupOwnershipMismatchError
  );
});

test("an absent root needs a captured surviving-member receipt before group signalling", async () => {
  let signalCount = 0;
  assert.equal(await signalOwnedProcessRoot(receipt, "SIGTERM", {
    readProcesses: async () => [],
    signalProcess: () => {
      signalCount += 1;
    }
  }), "already-exited");
  assert.equal(await forceOwnedProcessGroup(receipt, "SIGKILL", {
    readProcesses: async () => [],
    signalProcessGroup: () => {
      signalCount += 1;
    }
  }), "already-exited");
  await assert.rejects(
    forceOwnedProcessGroup(receipt, "SIGKILL", {
      readProcesses: async () => [member],
      signalProcessGroup: () => {
        signalCount += 1;
      }
    }),
    OwnedProcessGroupOwnershipMismatchError
  );
  assert.equal(await forceOwnedProcessGroup(receipt, "SIGKILL", {
    memberReceipts: [member],
    readProcesses: async () => [member],
    signalProcessGroup: () => {
      signalCount += 1;
    }
  }), "signalled");
  assert.equal(signalCount, 1);
});

test("exit waiting requires the whole exact group to disappear", async () => {
  const observations = [[receipt, member], [member], []];
  await waitForOwnedProcessGroupExit(receipt, {
    pollMs: 1,
    readProcesses: async () => observations.shift() ?? [],
    timeoutMs: 100
  });

  await assert.rejects(
    waitForOwnedProcessGroupExit(receipt, {
      pollMs: 1,
      readProcesses: async () => [member],
      timeoutMs: 5
    }),
    OwnedProcessGroupStillRunningError
  );
});
