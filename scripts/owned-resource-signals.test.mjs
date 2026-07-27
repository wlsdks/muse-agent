import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { installOwnedResourceSignalHandlers } from "./lib/owned-resource-signals.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

test("SIGINT waits for cleanup and exits 130 exactly once", async () => {
  const source = new EventEmitter();
  const cleanup = deferred();
  const exits = [];
  let closeCalls = 0;
  const uninstall = installOwnedResourceSignalHandlers({
    close: () => {
      closeCalls += 1;
      return cleanup.promise;
    },
    exit: (code) => exits.push(code),
    signalSource: source
  });

  source.emit("SIGINT");
  source.emit("SIGINT");
  source.emit("SIGTERM");
  await Promise.resolve();
  assert.equal(closeCalls, 1);
  assert.deepEqual(exits, []);
  cleanup.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(exits, [130]);
  uninstall();
  assert.equal(source.listenerCount("SIGINT"), 0);
  assert.equal(source.listenerCount("SIGTERM"), 0);
});

test("SIGTERM exits 143 only after successful cleanup", async () => {
  const source = new EventEmitter();
  const events = [];
  installOwnedResourceSignalHandlers({
    close: async () => {
      events.push("cleanup");
    },
    exit: (code) => events.push(`exit:${code.toString()}`),
    signalSource: source
  });

  source.emit("SIGTERM");
  source.emit("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events, ["cleanup", "exit:143"]);
});

test("cleanup failure is reported and exits 1 rather than claiming signal-safe cleanup", async () => {
  const source = new EventEmitter();
  const cleanupError = new Error("cleanup failed");
  const errors = [];
  const exits = [];
  installOwnedResourceSignalHandlers({
    close: async () => {
      throw cleanupError;
    },
    exit: (code) => exits.push(code),
    onCleanupError: (error) => errors.push(error),
    signalSource: source
  });

  source.emit("SIGINT");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(errors, [cleanupError]);
  assert.deepEqual(exits, [1]);
});
