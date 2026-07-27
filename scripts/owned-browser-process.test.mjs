import assert from "node:assert/strict";
import test from "node:test";

import {
  bindOwnedBrowserProcess,
  matchesOwnedBrowserProcess,
  observeOwnedBrowserProcess,
  OwnedBrowserOwnershipMismatchError,
  parsePsRecord,
  terminateOwnedBrowserProcess,
  waitForOwnedBrowserExit
} from "./lib/owned-browser-process.mjs";

const receipt = Object.freeze({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  launchId: "launch-exact-42",
  pid: 4242,
  processGroupId: 4242,
  spawnedAt: "2026-07-27T00:00:00.000Z",
  userDataDir: "/private/tmp/muse profile"
});

const observed = Object.freeze({
  args: `${receipt.executablePath} --user-data-dir=${receipt.userDataDir} --muse-launch-id=${receipt.launchId} --headless`,
  executablePath: receipt.executablePath,
  osStartedAt: "Sun Jul 27 10:00:00 2026",
  pid: receipt.pid,
  processGroupId: receipt.processGroupId
});
const boundReceipt = Object.freeze({ ...receipt, osStartedAt: observed.osStartedAt });

test("ps output parsing preserves pid, process group, OS start time, and command", async () => {
  const record = {
    args: `${observed.args}\n`,
    executablePath: `${observed.executablePath}\n`,
    metadata: " 4242  4242 Sun Jul 27 10:00:00 2026\n"
  };
  assert.deepEqual(parsePsRecord(record), observed);
  assert.deepEqual(await observeOwnedBrowserProcess(receipt, { runPs: () => record }), observed);
  assert.deepEqual(await bindOwnedBrowserProcess(receipt, { observe: async () => observed }), boundReceipt);
  await assert.rejects(
    bindOwnedBrowserProcess(
      { ...boundReceipt, osStartedAt: "Sun Jul 27 10:00:01 2026" },
      { observe: async () => observed }
    ),
    OwnedBrowserOwnershipMismatchError
  );
});

test("exact ownership requires birth, pid, process group, executable, profile, and launch id", () => {
  assert.equal(matchesOwnedBrowserProcess(boundReceipt, observed), true);
  assert.equal(matchesOwnedBrowserProcess(boundReceipt, { ...observed, osStartedAt: "Sun Jul 27 10:00:01 2026" }), false);
  assert.equal(matchesOwnedBrowserProcess(boundReceipt, { ...observed, pid: 4243 }), false);
  assert.equal(matchesOwnedBrowserProcess(boundReceipt, { ...observed, processGroupId: 7 }), false);
  assert.equal(matchesOwnedBrowserProcess(boundReceipt, { ...observed, executablePath: "/tmp/wrapper" }), false);
  assert.equal(matchesOwnedBrowserProcess(boundReceipt, {
    ...observed,
    args: observed.args.replace(receipt.launchId, `${receipt.launchId}-suffix`)
  }), false);
  assert.equal(matchesOwnedBrowserProcess(boundReceipt, {
    ...observed,
    args: observed.args.replace(receipt.userDataDir, `${receipt.userDataDir}-suffix`)
  }), false);
});

test("forced termination signals only the exact owned process group", async () => {
  const signals = [];
  const result = await terminateOwnedBrowserProcess(boundReceipt, {
    observe: async () => observed,
    signalProcessGroup: (processGroupId, signal) => signals.push({ processGroupId, signal })
  });
  assert.equal(result, "signalled");
  assert.deepEqual(signals, [{ processGroupId: 4242, signal: "SIGTERM" }]);
});

test("forced termination rejects every identity mismatch without signalling", async () => {
  const mismatches = [
    { ...observed, osStartedAt: "Sun Jul 27 10:00:01 2026" },
    { ...observed, executablePath: "/tmp/wrapper", args: `/tmp/wrapper ${observed.args}` },
    { ...observed, args: observed.args.replace(receipt.launchId, `${receipt.launchId}-suffix`) },
    { ...observed, args: observed.args.replace(receipt.userDataDir, `${receipt.userDataDir}-suffix`) }
  ];
  let signalCalls = 0;
  for (const mismatch of mismatches) {
    await assert.rejects(
      terminateOwnedBrowserProcess(boundReceipt, {
        observe: async () => mismatch,
        signalProcessGroup: () => {
          signalCalls += 1;
        }
      }),
      OwnedBrowserOwnershipMismatchError
    );
  }
  assert.equal(signalCalls, 0);
});

test("an already-exited process needs no signal", async () => {
  let signalCalls = 0;
  const result = await terminateOwnedBrowserProcess(boundReceipt, {
    observe: async () => undefined,
    signalProcessGroup: () => {
      signalCalls += 1;
    }
  });
  assert.equal(result, "already-exited");
  assert.equal(signalCalls, 0);
});

test("exit waiting accepts only absence or replacement, never a still-owned process", async () => {
  const observations = [observed, observed, undefined];
  await waitForOwnedBrowserExit(boundReceipt, {
    observe: async () => observations.shift(),
    pollMs: 1,
    timeoutMs: 100
  });

  await waitForOwnedBrowserExit(boundReceipt, {
    observe: async () => ({
      ...observed,
      args: observed.args.replace(receipt.launchId, "replacement")
    }),
    pollMs: 1,
    timeoutMs: 100
  });
});
