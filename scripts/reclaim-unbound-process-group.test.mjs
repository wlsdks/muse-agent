import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import { readProcessTable } from "./lib/process-lifecycle-diagnostics.mjs";
import {
  reclaimUnboundDetachedProcessGroup
} from "./lib/reclaim-unbound-process-group.mjs";

test("bind-failure fallback reclaims the detached root and its inherited descendant", async () => {
  const child = spawn(process.execPath, [
    "-e",
    [
      "const { spawn } = require('node:child_process');",
      "spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "setInterval(() => {}, 1000);"
    ].join("")
  ], {
    detached: true,
    stdio: "ignore"
  });
  const terminal = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  try {
    await waitForGroupSize(child.pid, 2);
    await reclaimUnboundDetachedProcessGroup({
      processGroupId: child.pid,
      terminal
    });
    assert.equal(
      (await readProcessTable()).filter((record) =>
        record.processGroupId === child.pid
      ).length,
      0
    );
  } finally {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "ESRCH") throw error;
    }
    await terminal;
  }
});

async function waitForGroupSize(processGroupId, expected) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const members = (await readProcessTable()).filter((record) =>
      record.processGroupId === processGroupId
    );
    if (members.length >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`detached fixture did not reach ${expected.toString()} group members`);
}
