import assert from "node:assert/strict";
import test from "node:test";

import {
  createExactOwnershipReceipt,
  isExactOwnershipReceipt,
  OwnedResourceCleanupTimeoutError,
  OwnedResourceForceRefusedError,
  OwnedResourceScope,
  ownedResourceCleanupFailures
} from "./lib/owned-resource-scope.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

test("cleanup slots exist before acquisition settles and late acquisition is released", async () => {
  const acquisition = deferred();
  const releases = [];
  const scope = new OwnedResourceScope();
  const acquired = scope.acquire({
    acquire: () => acquisition.promise,
    label: "late",
    release: (value) => {
      releases.push(value);
    }
  });

  const closing = scope.close();
  acquisition.resolve("resource");

  assert.equal(await acquired, "resource");
  await closing;
  assert.deepEqual(releases, ["resource"]);
});

test("cleanup runs in reverse order exactly once across concurrent close calls", async () => {
  const releases = [];
  const scope = new OwnedResourceScope();
  await scope.acquire({ acquire: () => "first", label: "first", release: (value) => releases.push(value) });
  await scope.acquire({ acquire: () => "second", label: "second", release: (value) => releases.push(value) });

  const firstClose = scope.close();
  const secondClose = scope.close();
  assert.equal(firstClose, secondClose);
  await Promise.all([firstClose, secondClose]);
  await scope.close();

  assert.deepEqual(releases, ["second", "first"]);
});

test("an acquisition cannot start after cleanup begins", async () => {
  const scope = new OwnedResourceScope();
  await scope.close();
  let acquireCalls = 0;

  await assert.rejects(
    scope.acquire({
      acquire: () => {
        acquireCalls += 1;
        return "unsafe";
      },
      label: "too-late",
      release: () => {}
    }),
    /after owned-resource cleanup has started/u
  );
  assert.equal(acquireCalls, 0);
});

test("cleanup deadline is bounded and refuses inferred forced ownership", async () => {
  const neverReleased = deferred();
  let forceCalls = 0;
  const scope = new OwnedResourceScope({ cleanupTimeoutMs: 20, forceCleanupTimeoutMs: 20 });
  await scope.acquire({
    acquire: () => ({ ownership: { id: 42 }, value: "process" }),
    forceRelease: () => {
      forceCalls += 1;
    },
    label: "unproven-process",
    release: () => neverReleased.promise
  });

  const startedAt = Date.now();
  await assert.rejects(scope.close(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.ok(error.errors.some((entry) => entry instanceof OwnedResourceCleanupTimeoutError));
    assert.ok(error.errors.some((entry) => entry instanceof OwnedResourceForceRefusedError));
    return true;
  });
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(forceCalls, 0);
});

test("a never-settling acquisition cannot make cleanup or forced fallback unbounded", async () => {
  const acquisition = deferred();
  let forceCalls = 0;
  const scope = new OwnedResourceScope({ cleanupTimeoutMs: 20, forceCleanupTimeoutMs: 20 });
  void scope.acquire({
    acquire: () => acquisition.promise,
    forceRelease: () => {
      forceCalls += 1;
    },
    label: "not-yet-owned",
    release: () => {}
  });

  const startedAt = Date.now();
  await assert.rejects(scope.close(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.ok(error.errors.some((entry) => entry instanceof OwnedResourceCleanupTimeoutError));
    assert.ok(error.errors.some((entry) => entry instanceof OwnedResourceForceRefusedError));
    return true;
  });
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(forceCalls, 0);
});

test("a newer pending acquisition does not block an older owned resource cleanup", async () => {
  const pending = deferred();
  let olderReleaseCalls = 0;
  const scope = new OwnedResourceScope({ cleanupTimeoutMs: 20, forceCleanupTimeoutMs: 20 });
  await scope.acquire({
    acquire: () => "older",
    label: "older-owned",
    release: () => {
      olderReleaseCalls += 1;
    }
  });
  void scope.acquire({
    acquire: () => pending.promise,
    label: "newer-pending",
    release: () => {}
  });

  await assert.rejects(scope.close(), OwnedResourceCleanupTimeoutError);
  assert.equal(olderReleaseCalls, 1);
});

test("late exact ownership gets one bounded forced cleanup if graceful release hangs", async () => {
  const acquisition = deferred();
  const neverReleased = deferred();
  const receipt = createExactOwnershipReceipt({
    acquiredAt: "2026-07-27T00:00:00.000Z",
    id: 4343,
    kind: "process"
  });
  let forceCalls = 0;
  let releaseCalls = 0;
  const scope = new OwnedResourceScope({ cleanupTimeoutMs: 20, forceCleanupTimeoutMs: 20 });
  void scope.acquire({
    acquire: () => acquisition.promise,
    forceRelease: () => {
      forceCalls += 1;
    },
    label: "late-owned-process",
    release: () => {
      releaseCalls += 1;
      return neverReleased.promise;
    }
  });

  await assert.rejects(scope.close(), AggregateError);
  acquisition.resolve({ ownership: receipt, value: "process" });
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(releaseCalls, 1);
  assert.equal(forceCalls, 1);
});

test("forced cleanup receives only a branded exact ownership receipt and runs once", async () => {
  const neverReleased = deferred();
  const receipt = createExactOwnershipReceipt({
    acquiredAt: "2026-07-27T00:00:00.000Z",
    id: 4242,
    kind: "process"
  });
  const forced = [];
  const scope = new OwnedResourceScope({ cleanupTimeoutMs: 20, forceCleanupTimeoutMs: 100 });
  await scope.acquire({
    acquire: () => ({ ownership: receipt, value: "process" }),
    forceRelease: (value, ownership) => {
      forced.push({ ownership, value });
    },
    label: "owned-process",
    release: () => neverReleased.promise
  });

  await assert.rejects(scope.close(), OwnedResourceCleanupTimeoutError);
  await assert.rejects(scope.close(), OwnedResourceCleanupTimeoutError);
  assert.deepEqual(forced, [{ ownership: receipt, value: "process" }]);
  assert.equal(isExactOwnershipReceipt(receipt), true);
  assert.equal(isExactOwnershipReceipt({ ...receipt }), false);
});

test("the primary failure remains authoritative when cleanup also fails", async () => {
  const primary = Object.freeze(new Error("work failed"));
  const cleanup = new Error("cleanup failed");
  const scope = new OwnedResourceScope();
  await scope.acquire({
    acquire: () => "resource",
    label: "failing-cleanup",
    release: () => {
      throw cleanup;
    }
  });

  await assert.rejects(scope.close({ primaryError: primary }), (error) => error === primary);
  assert.deepEqual(ownedResourceCleanupFailures(primary), [cleanup]);
});

test("an acquisition failure does not call release", async () => {
  const scope = new OwnedResourceScope();
  const acquisitionFailure = new Error("acquire failed");
  let releaseCalls = 0;

  await assert.rejects(
    scope.acquire({
      acquire: () => {
        throw acquisitionFailure;
      },
      label: "failed-acquisition",
      release: () => {
        releaseCalls += 1;
      }
    }),
    (error) => error === acquisitionFailure
  );
  await scope.close();
  assert.equal(releaseCalls, 0);
});
