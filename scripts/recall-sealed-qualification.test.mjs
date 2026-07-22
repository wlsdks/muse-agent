import assert from "node:assert/strict";
import { createDecipheriv, createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  open as openFile,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  CANDIDATE_CATEGORIES,
  CANDIDATE_DOMAINS,
  CANDIDATE_LOCALES,
  createSealedQualificationStore,
  sealedFailureCode
} from "./recall-sealed-qualification.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");

function makePool180(salt = "") {
  const pool = [];
  for (const category of CANDIDATE_CATEGORIES) {
    for (const locale of CANDIDATE_LOCALES) {
      for (const domain of CANDIDATE_DOMAINS) {
        for (let index = 0; index < 6; index += 1) {
          const token = digest(`${salt}|${category}|${locale}|${domain}|${index.toString()}`);
          pool.push({
            category,
            domain,
            locale,
            scorer: { expectedHash: digest(`expected|${token}`) },
            solver: {
              corpus: [{ sourceHash: digest(`source|${token}`), text: `evidence${token}` }],
              query: `question${token}`,
              runtimeOptions: { refine: true, topK: 3 }
            }
          });
        }
      }
    }
  }
  return pool;
}

async function withRoot(prefix, run) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  try {
    await run(root);
  } finally {
    await rm(root, {
      force: true,
      maxRetries: 10,
      recursive: true,
      retryDelay: 20
    });
  }
}

test("trusted-root facade seals a canonical private pool with strict modes and no plaintext", async () => {
  await withRoot("muse-sealed-store-", async (root) => {
    const store = createSealedQualificationStore(root);
    assert.deepEqual(Object.keys(store).sort(), [
      "inspect",
      "reconcile",
      "reproducePassedOnce",
      "sealPoolOnce",
      "selectFinal90Once"
    ]);

    const pool = makePool180();
    const receipt = await store.sealPoolOnce({
      metadata: { qualification: "recall-v1" },
      pool,
      priorPayloads: [`unrelated${digest("prior-a")}`, `unrelated${digest("prior-b")}`]
    });
    assert.equal(receipt.cases, 180);
    assert.equal(receipt.cells, 30);
    assert.equal(receipt.casesPerCell, 6);
    assert.equal(typeof receipt.sealedHandle, "function");
    assert.equal(JSON.stringify(receipt.sealedHandle), undefined);
    assert.throws(() => structuredClone(receipt.sealedHandle));
    assert.match(receipt.poolHash, /^[a-f0-9]{64}$/u);
    assert.match(receipt.metadataHash, /^[a-f0-9]{64}$/u);
    assert.match(receipt.poolEnvelopeHash, /^[a-f0-9]{64}$/u);
    assert.equal(receipt.overlap.prior.exactDuplicates, 0);
    assert.ok(receipt.overlap.prior.maxSimilarity <= 0.35);
    assert.equal(receipt.overlap.prior.comparisons, 720);
    assert.equal(receipt.overlap.prior.excludedSameCaseComparisons, 0);
    assert.equal(receipt.overlap.internal.exactDuplicates, 0);
    assert.ok(receipt.overlap.internal.maxSimilarity <= 0.8);
    assert.equal(receipt.overlap.internal.comparisons, 64_440);
    assert.equal(receipt.overlap.internal.excludedSameCaseComparisons, 180);
    assert.deepEqual(Object.keys(receipt.overlap).sort(), ["internal", "prior"]);
    for (const summary of [receipt.overlap.internal, receipt.overlap.prior]) {
      assert.deepEqual(
        Object.keys(summary).sort(),
        [
          "comparisons",
          "exactDuplicates",
          "excludedSameCaseComparisons",
          "maxSimilarity",
          "witnessHashes"
        ]
      );
      assert.equal(
        summary.witnessHashes.every((hash) => /^[a-f0-9]{64}$/u.test(hash)),
        true
      );
      assert.equal(Object.hasOwn(summary, "payload"), false);
    }
    assert.equal(Object.hasOwn(receipt, "pool"), false);

    const files = await readdir(root);
    assert.ok(files.length >= 3);
    assert.equal(files.some((name) => name.endsWith(".key")), false);
    assert.equal(Object.keys(receipt).some((key) => key.toLowerCase().includes("key")), false);
    const secret = pool[0].solver.query;
    for (const name of files) {
      const stat = await lstat(join(root, name));
      assert.equal(stat.isSymbolicLink(), false);
      assert.equal(stat.isFile(), true);
      assert.equal(stat.mode & 0o777, 0o600);
      assert.equal((await readFile(join(root, name))).includes(Buffer.from(secret)), false);
    }
    const envelope = JSON.parse(await readFile(
      join(root, "pool-" + receipt.poolHash + ".envelope"),
      "utf8"
    ));
    const publicKeyCandidates = Object.values(receipt)
      .filter((value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value))
      .map((value) => Buffer.from(value, "hex"));
    assert.ok(publicKeyCandidates.length >= 4);
    for (const candidate of publicKeyCandidates) {
      assert.throws(() => {
        const decipher = createDecipheriv(
          "aes-256-gcm",
          candidate,
          Buffer.from(envelope.ivBase64, "base64"),
          { authTagLength: 16 }
        );
        decipher.setAAD(Buffer.from(
          "muse-recall-sealed-envelope-v2\u0000aes-256-gcm",
          "utf8"
        ));
        decipher.setAuthTag(Buffer.from(envelope.authTagBase64, "base64"));
        decipher.update(Buffer.from(envelope.ciphertextBase64, "base64"));
        decipher.final();
      });
      candidate.fill(0);
    }
  });

  await withRoot("muse-sealed-bad-mode-", async (root) => {
    await chmod(root, 0o755);
    assert.throws(
      () => createSealedQualificationStore(root),
      (error) => sealedFailureCode(error) === "SEALED_ROOT_INVALID"
    );
  });

  await withRoot("muse-sealed-symlink-target-", async (target) => {
    const link = `${target}-link`;
    await symlink(target, link);
    try {
      assert.throws(
        () => createSealedQualificationStore(link),
        (error) => sealedFailureCode(error) === "SEALED_ROOT_INVALID"
      );
    } finally {
      await rm(link, { force: true });
    }
  });
});

test("sealed pool capability is same-store, nonreconstructible, one-shot memory and restart reconciliation burns it", async () => {
  await withRoot("muse-sealed-capability-", async (root) => {
    const ownerStore = createSealedQualificationStore(root);
    const sealed = await ownerStore.sealPoolOnce({
      metadata: { qualification: "opaque-capability" },
      pool: makePool180("opaque-capability"),
      priorPayloads: []
    });
    assert.equal(typeof sealed.sealedHandle, "function");
    assert.deepEqual(Object.keys(sealed.sealedHandle), []);
    assert.equal(JSON.stringify(sealed.sealedHandle), undefined);
    assert.throws(() => structuredClone(sealed.sealedHandle));

    let foreignCalls = 0;
    const foreignStore = createSealedQualificationStore(root);
    await assert.rejects(
      foreignStore.selectFinal90Once(sealed.sealedHandle, async () => {
        foreignCalls += 1;
      }),
      (error) => sealedFailureCode(error) === "SEALED_LIFECYCLE_CLOSED"
    );
    await assert.rejects(
      ownerStore.selectFinal90Once(function reconstructedHandle() {}, async () => {
        foreignCalls += 1;
      }),
      (error) => sealedFailureCode(error) === "SEALED_LIFECYCLE_CLOSED"
    );
    await assert.rejects(
      ownerStore.selectFinal90Once(
        "sq1:" + sealed.poolHash + ":" + sealed.poolEnvelopeHash,
        async () => {
          foreignCalls += 1;
        }
      ),
      (error) => sealedFailureCode(error) === "SEALED_LIFECYCLE_CLOSED"
    );
    assert.equal(foreignCalls, 0);

    await ownerStore.selectFinal90Once(sealed.sealedHandle, async () => {});
    assert.equal((await readdir(root)).some((name) => name.endsWith(".key")), false);
  });

  await withRoot("muse-sealed-restart-burn-", async (root) => {
    const originalStore = createSealedQualificationStore(root);
    const sealed = await originalStore.sealPoolOnce({
      metadata: { qualification: "restart-burn" },
      pool: makePool180("restart-burn"),
      priorPayloads: []
    });
    assert.equal((await originalStore.reconcile()).burnedCount, 0);
    assert.equal((await originalStore.inspect()).pools[0].status, "sealed");

    const restartedStore = createSealedQualificationStore(root);
    assert.equal((await restartedStore.reconcile()).burnedCount, 1);
    assert.equal((await restartedStore.inspect()).pools[0].status, "burned");
    let calls = 0;
    await assert.rejects(
      originalStore.selectFinal90Once(sealed.sealedHandle, async () => {
        calls += 1;
      }),
      (error) => sealedFailureCode(error) === "SEALED_LIFECYCLE_CLOSED"
    );
    assert.equal(calls, 0);
    assert.equal((await readdir(root)).some((name) => name.endsWith(".key")), false);
  });

  await withRoot("muse-sealed-pre-network-failure-", async (root) => {
    const store = createSealedQualificationStore(root);
    const sealed = await store.sealPoolOnce({
      metadata: { qualification: "pre-network-failure" },
      pool: makePool180("pre-network-failure"),
      priorPayloads: []
    });
    await assert.rejects(
      store.selectFinal90Once(sealed.sealedHandle, null),
      (error) => sealedFailureCode(error) === "SEALED_NETWORK_CALLBACK_FAILED"
    );
    let calls = 0;
    await assert.rejects(
      store.selectFinal90Once(sealed.sealedHandle, async () => {
        calls += 1;
      }),
      (error) => sealedFailureCode(error) === "SEALED_LIFECYCLE_CLOSED"
    );
    assert.equal(calls, 0);
    assert.equal((await store.reconcile()).burnedCount, 1);
    assert.equal((await readdir(root)).some((name) => name.endsWith(".key")), false);
  });
});

test("seal boundary rejects schema/overlap bypasses, caller ids, re-seals, and hostile proxies", async () => {
  await withRoot("muse-sealed-adversarial-", async (root) => {
    const store = createSealedQualificationStore(root);
    const pool = makePool180();

    const solverExtra = structuredClone(pool);
    solverExtra[0].solver.opaqueId = "0".repeat(32);
    await assert.rejects(
      store.sealPoolOnce({
        metadata: {},
        pool: solverExtra,
        priorPayloads: []
      }),
      (error) => sealedFailureCode(error) === "SEALED_SOLVER_SCHEMA_INVALID"
    );

    const callerSequentialIds = structuredClone(pool);
    for (let index = 0; index < callerSequentialIds.length; index += 1) {
      callerSequentialIds[index].opaqueId = index.toString(16).padStart(32, "0");
    }
    await assert.rejects(
      store.sealPoolOnce({
        metadata: {},
        pool: callerSequentialIds,
        priorPayloads: []
      }),
      (error) => sealedFailureCode(error) === "SEALED_MATRIX_INVALID"
    );

    for (const exactPrior of [
      pool[0].solver.query,
      pool[0].solver.corpus[0].text
    ]) {
      await assert.rejects(
        store.sealPoolOnce({
          metadata: {},
          pool,
          priorPayloads: [exactPrior]
        }),
        (error) => sealedFailureCode(error) === "SEALED_OVERLAP_INVALID"
      );
      const closePrior = exactPrior.slice(0, -1) +
        (exactPrior.endsWith("a") ? "b" : "a");
      await assert.rejects(
        store.sealPoolOnce({
          metadata: {},
          pool,
          priorPayloads: [closePrior]
        }),
        (error) => sealedFailureCode(error) === "SEALED_OVERLAP_INVALID"
      );
    }

    const toFullwidthUpper = (value) => Array.from(value.toUpperCase())
      .map((codePoint) => /[A-Z0-9]/u.test(codePoint)
        ? String.fromCodePoint(codePoint.codePointAt(0) + 0xfee0)
        : codePoint)
      .join("") + "🙂-!";
    await assert.rejects(
      store.sealPoolOnce({
        metadata: {},
        pool,
        priorPayloads: [toFullwidthUpper(pool[0].solver.query)]
      }),
      (error) => sealedFailureCode(error) === "SEALED_OVERLAP_INVALID"
    );

    const duplicateQuery = structuredClone(pool);
    duplicateQuery[1].solver.query = duplicateQuery[0].solver.query;
    await assert.rejects(
      store.sealPoolOnce({
        metadata: {},
        pool: duplicateQuery,
        priorPayloads: []
      }),
      (error) => sealedFailureCode(error) === "SEALED_OVERLAP_INVALID"
    );

    const duplicateChunk = structuredClone(pool);
    duplicateChunk[1].solver.corpus[0].text = duplicateChunk[0].solver.corpus[0].text;
    await assert.rejects(
      store.sealPoolOnce({
        metadata: {},
        pool: duplicateChunk,
        priorPayloads: []
      }),
      (error) => sealedFailureCode(error) === "SEALED_OVERLAP_INVALID"
    );

    for (const part of ["query", "chunk"]) {
      const internalTooClose = structuredClone(pool);
      if (part === "query") {
        const original = internalTooClose[0].solver.query;
        internalTooClose[1].solver.query = original.slice(0, -1) +
          (original.endsWith("a") ? "b" : "a");
      } else {
        const original = internalTooClose[0].solver.corpus[0].text;
        internalTooClose[1].solver.corpus[0].text = original.slice(0, -1) +
          (original.endsWith("a") ? "b" : "a");
      }
      await assert.rejects(
        store.sealPoolOnce({
          metadata: {},
          pool: internalTooClose,
          priorPayloads: []
        }),
        (error) => sealedFailureCode(error) === "SEALED_OVERLAP_INVALID"
      );
    }

    await assert.rejects(
      store.sealPoolOnce({
        metadata: {},
        pool,
        priorPayloads: Array.from(
          { length: 1_001 },
          (_, index) => "bounded-prior-" + index.toString()
        )
      }),
      (error) => sealedFailureCode(error) === "SEALED_OVERLAP_INVALID"
    );

    const receipt = await store.sealPoolOnce({
      metadata: { version: 1 },
      pool,
      priorPayloads: []
    });
    await assert.rejects(
      store.sealPoolOnce({
        metadata: { version: 2 },
        pool: [...pool].reverse(),
        priorPayloads: []
      }),
      (error) => sealedFailureCode(error) === "SEALED_LIFECYCLE_CLOSED"
    );
    const state = await store.inspect();
    assert.equal(state.pools.find((item) => item.poolHash === receipt.poolHash).status, "sealed");

    const hostile = new Proxy({}, {
      ownKeys() {
        throw new Error("hostile-ownKeys");
      }
    });
    await assert.rejects(
      store.sealPoolOnce(hostile),
      (error) => sealedFailureCode(error) === "SEALED_INTERNAL_FAILURE" &&
        error.message === "SEALED_INTERNAL_FAILURE"
    );
    const spoofed = new Error("RAW_SECRET_MESSAGE");
    spoofed.code = "SEALED_OVERLAP_INVALID";
    spoofed.stack = "RAW_SECRET_STACK";
    const secretThrowingProxy = new Proxy({}, {
      getPrototypeOf() {
        throw spoofed;
      }
    });
    await assert.rejects(
      store.sealPoolOnce(secretThrowingProxy),
      (error) => {
        assert.equal(sealedFailureCode(error), "SEALED_INTERNAL_FAILURE");
        assert.equal(error.code, "SEALED_INTERNAL_FAILURE");
        assert.equal(error.message, "SEALED_INTERNAL_FAILURE");
        assert.equal(error.stack, "SEALED_INTERNAL_FAILURE");
        assert.equal(JSON.stringify(error).includes("RAW_SECRET"), false);
        return true;
      }
    );
    assert.equal(sealedFailureCode(spoofed), "SEALED_INTERNAL_FAILURE");
    let hostileReads = 0;
    const hostileError = new Proxy({}, {
      get() {
        hostileReads += 1;
        throw new Error("hostile-get");
      }
    });
    assert.equal(sealedFailureCode(hostileError), "SEALED_INTERNAL_FAILURE");
    assert.equal(hostileReads, 0);
  });
});

test("selectFinal90Once consumes the sealed pool internally, marks used first, and selects exactly three per cell", async () => {
  await withRoot("muse-sealed-select-", async (root) => {
    const store = createSealedQualificationStore(root);
    const pool = makePool180();
    const cellByQuery = new Map(pool.map((item) => [
      item.solver.query,
      item.category + "|" + item.locale + "|" + item.domain
    ]));
    const sealed = await store.sealPoolOnce({
      metadata: { qualification: "selection" },
      pool,
      priorPayloads: []
    });
    let selectedDigest;
    let callbackCalls = 0;
    const passed = await store.selectFinal90Once(sealed.sealedHandle, async (selected) => {
      callbackCalls += 1;
      assert.equal(selected.length, 90);
      assert.equal(new Set(selected.map((item) => item.opaqueId)).size, 90);
      const cellCounts = new Map();
      for (const item of selected) {
        assert.deepEqual(Object.keys(item).sort(), ["opaqueId", "solver"]);
        assert.deepEqual(
          Object.keys(item.solver).sort(),
          ["corpus", "opaqueId", "query", "runtimeOptions"]
        );
        assert.match(item.opaqueId, /^[a-f0-9]{32}$/u);
        assert.equal(item.solver.opaqueId, item.opaqueId);
        assert.equal(Object.hasOwn(item, "scorer"), false);
        assert.equal(Object.hasOwn(item, "category"), false);
        assert.equal(Object.hasOwn(item, "locale"), false);
        assert.equal(Object.hasOwn(item, "domain"), false);
        const cell = cellByQuery.get(item.solver.query);
        assert.equal(typeof cell, "string");
        cellCounts.set(cell, (cellCounts.get(cell) ?? 0) + 1);
      }
      assert.equal(cellCounts.size, 30);
      assert.equal([...cellCounts.values()].every((count) => count === 3), true);
      selectedDigest = digest(JSON.stringify(selected));
      const during = await store.inspect();
      assert.equal(during.pools[0].status, "consuming");
    });
    assert.equal(callbackCalls, 1);
    assert.equal(passed.cases, 90);
    assert.equal(passed.cells, 30);
    assert.equal(passed.casesPerCell, 3);
    assert.deepEqual(passed.categoryCounts, { absent: 30, correction: 30, ordinary: 30 });
    assert.deepEqual(passed.localeCounts, { en: 45, ko: 45 });
    assert.deepEqual(
      passed.domainCounts,
      { health: 18, life: 18, preference: 18, reference: 18, work: 18 }
    );
    assert.equal(passed.finalDatasetHash, selectedDigest);
    assert.equal(typeof passed.passedHandle, "function");
    assert.equal(JSON.stringify(passed.passedHandle), undefined);
    assert.match(passed.claimHeadHash, /^[a-f0-9]{64}$/u);
    assert.match(passed.consumingHeadHash, /^[a-f0-9]{64}$/u);
    assert.match(passed.terminalHeadHash, /^[a-f0-9]{64}$/u);
    assert.equal((await store.inspect()).pools[0].status, "passed");

    await assert.rejects(
      store.selectFinal90Once(sealed.sealedHandle, async () => {
        callbackCalls += 1;
      }),
      (error) => sealedFailureCode(error) === "SEALED_LIFECYCLE_CLOSED"
    );
    assert.equal(callbackCalls, 1);
  });
});

test("reproducePassedOnce is session-bound, exact-bytes, and exactly once", async () => {
  await withRoot("muse-sealed-reproduce-", async (root) => {
    const store = createSealedQualificationStore(root);
    const sealed = await store.sealPoolOnce({
      metadata: { qualification: "reproduction" },
      pool: makePool180(),
      priorPayloads: []
    });
    let originalDigest;
    const passed = await store.selectFinal90Once(sealed.sealedHandle, async (selected) => {
      originalDigest = digest(JSON.stringify(selected));
    });

    let reproductionCalls = 0;
    let reproducedDigest;
    const reproduced = await store.reproducePassedOnce(
      passed.passedHandle,
      async (selected) => {
        reproductionCalls += 1;
        reproducedDigest = digest(JSON.stringify(selected));
        assert.equal((await store.inspect()).pools[0].status, "reproduction-consuming");
      }
    );
    assert.equal(reproductionCalls, 1);
    assert.equal(reproducedDigest, originalDigest);
    assert.equal(reproduced.finalDatasetHash, passed.finalDatasetHash);
    assert.equal(reproduced.poolHash, passed.poolHash);
    assert.equal(reproduced.poolEnvelopeHash, passed.poolEnvelopeHash);
    assert.equal(reproduced.metadataHash, passed.metadataHash);
    assert.match(reproduced.claimHeadHash, /^[a-f0-9]{64}$/u);
    assert.match(reproduced.consumingHeadHash, /^[a-f0-9]{64}$/u);
    assert.match(reproduced.terminalHeadHash, /^[a-f0-9]{64}$/u);
    assert.equal((await store.inspect()).pools[0].status, "reproduced");

    await assert.rejects(
      store.reproducePassedOnce(passed.passedHandle, async () => {
        reproductionCalls += 1;
      }),
      (error) => sealedFailureCode(error) === "SEALED_REPRODUCTION_CLOSED"
    );
    await assert.rejects(
      store.reproducePassedOnce(function forgedCapability() {}, async () => {
        reproductionCalls += 1;
      }),
      (error) => sealedFailureCode(error) === "SEALED_REPRODUCTION_CLOSED"
    );
    assert.equal(reproductionCalls, 1);
  });
});

test("reconciliation burns claim-only crashes and consuming orphans after ledger append faults", async () => {
  await withRoot("muse-sealed-reconcile-claim-", async (root) => {
    const store = createSealedQualificationStore(root);
    const sealed = await store.sealPoolOnce({
      metadata: { qualification: "claim-crash" },
      pool: makePool180(),
      priorPayloads: []
    });
    const probe = await openFile(join(root, "prototype-probe"), "wx", 0o600);
    const prototype = Object.getPrototypeOf(probe);
    const originalWriteFile = prototype.writeFile;
    await probe.close();
    await rm(join(root, "prototype-probe"), { force: true });
    let callbacks = 0;
    prototype.writeFile = async function failConsumingLedger(data, ...args) {
      const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      if (text.includes('"status":"consuming"')) {
        throw new Error("injected-ledger-append-failure");
      }
      return originalWriteFile.call(this, data, ...args);
    };
    try {
      await assert.rejects(
        store.selectFinal90Once(sealed.sealedHandle, async () => {
          callbacks += 1;
        }),
        (error) => sealedFailureCode(error) === "SEALED_LEDGER_IO_FAILED"
      );
    } finally {
      prototype.writeFile = originalWriteFile;
    }
    assert.equal(callbacks, 0);
    assert.equal((await store.inspect()).pools[0].status, "sealed");
    const reconciled = await store.reconcile();
    assert.equal(reconciled.burnedCount, 1);
    assert.equal((await store.inspect()).pools[0].status, "burned");
    assert.equal((await readdir(root)).some((name) => name.endsWith(".key")), false);
  });

  await withRoot("muse-sealed-reconcile-consuming-", async (root) => {
    const store = createSealedQualificationStore(root);
    const sealed = await store.sealPoolOnce({
      metadata: { qualification: "consuming-crash" },
      pool: makePool180(),
      priorPayloads: []
    });
    const probe = await openFile(join(root, "prototype-probe"), "wx", 0o600);
    const prototype = Object.getPrototypeOf(probe);
    const originalWriteFile = prototype.writeFile;
    await probe.close();
    await rm(join(root, "prototype-probe"), { force: true });
    prototype.writeFile = async function failPassedLedger(data, ...args) {
      const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      if (text.includes('"status":"passed"')) {
        throw new Error("injected-terminal-append-failure");
      }
      return originalWriteFile.call(this, data, ...args);
    };
    try {
      await assert.rejects(
        store.selectFinal90Once(sealed.sealedHandle, async () => {}),
        (error) => sealedFailureCode(error) === "SEALED_LEDGER_IO_FAILED"
      );
    } finally {
      prototype.writeFile = originalWriteFile;
    }
    assert.equal((await store.inspect()).pools[0].status, "consuming");
    const reconciled = await store.reconcile();
    assert.equal(reconciled.burnedCount, 1);
    assert.equal((await store.inspect()).pools[0].status, "burned");
  });
});

test("network callback failures close initial and reproduction work as durable burns", async () => {
  await withRoot("muse-sealed-network-burn-", async (root) => {
    const store = createSealedQualificationStore(root);
    const pool = makePool180();
    const sealed = await store.sealPoolOnce({
      metadata: { qualification: "network-burn" },
      pool,
      priorPayloads: []
    });
    let calls = 0;
    await assert.rejects(
      store.selectFinal90Once(sealed.sealedHandle, async () => {
        calls += 1;
        throw new Error("raw-network-error-must-not-escape");
      }),
      (error) => sealedFailureCode(error) === "SEALED_NETWORK_CALLBACK_FAILED" &&
        error.message === "SEALED_NETWORK_CALLBACK_FAILED"
    );
    assert.equal(calls, 1);
    const burned = await store.inspect();
    assert.equal(burned.pools[0].status, "burned");
    assert.equal(burned.pools[0].terminalHeadHash, burned.headHash);
    assert.equal((await readdir(root)).some((name) => name.endsWith(".key")), false);
    await assert.rejects(
      store.sealPoolOnce({
        metadata: { qualification: "different-dataset" },
        pool: [...pool].reverse(),
        priorPayloads: []
      }),
      (error) => sealedFailureCode(error) === "SEALED_LIFECYCLE_CLOSED"
    );
  });

  await withRoot("muse-sealed-reproduction-burn-", async (root) => {
    const store = createSealedQualificationStore(root);
    const sealed = await store.sealPoolOnce({
      metadata: { qualification: "reproduction-burn" },
      pool: makePool180(),
      priorPayloads: []
    });
    const passed = await store.selectFinal90Once(sealed.sealedHandle, async () => {});
    let calls = 0;
    await assert.rejects(
      store.reproducePassedOnce(passed.passedHandle, async () => {
        calls += 1;
        throw new Error("reproduction-network-failed");
      }),
      (error) => sealedFailureCode(error) === "SEALED_NETWORK_CALLBACK_FAILED"
    );
    assert.equal((await store.inspect()).pools[0].status, "burned");
    await assert.rejects(
      store.reproducePassedOnce(passed.passedHandle, async () => {
        calls += 1;
      }),
      (error) => sealedFailureCode(error) === "SEALED_REPRODUCTION_CLOSED"
    );
    assert.equal(calls, 1);
  });
});

test("cross-instance serialization admits one same-pool winner and preserves distinct-pool chain integrity", async () => {
  await withRoot("muse-sealed-concurrent-same-", async (root) => {
    const firstStore = createSealedQualificationStore(root);
    const secondStore = createSealedQualificationStore(root);
    const input = {
      metadata: { qualification: "concurrent-same" },
      pool: makePool180("same"),
      priorPayloads: []
    };
    const sealResults = await Promise.allSettled([
      firstStore.sealPoolOnce(input),
      secondStore.sealPoolOnce(input)
    ]);
    assert.equal(sealResults.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(
      sealResults.filter((result) =>
        result.status === "rejected" &&
        sealedFailureCode(result.reason) === "SEALED_LIFECYCLE_CLOSED"
      ).length,
      1
    );
    const sealed = sealResults.find((result) => result.status === "fulfilled").value;
    let networkCalls = 0;
    const selectionResults = await Promise.allSettled([
      firstStore.selectFinal90Once(sealed.sealedHandle, async () => {
        networkCalls += 1;
      }),
      secondStore.selectFinal90Once(sealed.sealedHandle, async () => {
        networkCalls += 1;
      })
    ]);
    assert.equal(selectionResults.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(
      selectionResults.filter((result) =>
        result.status === "rejected" &&
        sealedFailureCode(result.reason) === "SEALED_LIFECYCLE_CLOSED"
      ).length,
      1
    );
    assert.equal(networkCalls, 1);
    const state = await firstStore.inspect();
    assert.equal(state.entries, 3);
    assert.equal(state.pools[0].status, "passed");
  });

  await withRoot("muse-sealed-concurrent-distinct-", async (root) => {
    const firstStore = createSealedQualificationStore(root);
    const secondStore = createSealedQualificationStore(root);
    const [first, second] = await Promise.all([
      firstStore.sealPoolOnce({
        metadata: { qualification: "distinct-a" },
        pool: makePool180("distinct-a"),
        priorPayloads: []
      }),
      secondStore.sealPoolOnce({
        metadata: { qualification: "distinct-b" },
        pool: makePool180("distinct-b"),
        priorPayloads: []
      })
    ]);
    let networkCalls = 0;
    await Promise.all([
      firstStore.selectFinal90Once(first.sealedHandle, async () => {
        networkCalls += 1;
      }),
      secondStore.selectFinal90Once(second.sealedHandle, async () => {
        networkCalls += 1;
      })
    ]);
    assert.equal(networkCalls, 2);
    const state = await firstStore.inspect();
    assert.equal(state.entries, 6);
    assert.equal(state.pools.length, 2);
    assert.equal(state.pools.every((item) => item.status === "passed"), true);
    assert.match(state.headHash, /^[a-f0-9]{64}$/u);
  });
});

test("exact envelope hashes and private-file lstat/modes reject substitution and symlink attacks before callbacks", async () => {
  await withRoot("muse-sealed-substitution-", async (root) => {
    const store = createSealedQualificationStore(root);
    const first = await store.sealPoolOnce({
      metadata: { qualification: "substitution-a" },
      pool: makePool180("substitution-a"),
      priorPayloads: []
    });
    const second = await store.sealPoolOnce({
      metadata: { qualification: "substitution-b" },
      pool: makePool180("substitution-b"),
      priorPayloads: []
    });
    const secondEnvelope = await readFile(
      join(root, "pool-" + second.poolHash + ".envelope")
    );
    await writeFile(
      join(root, "pool-" + first.poolHash + ".envelope"),
      secondEnvelope,
      { mode: 0o600 }
    );
    let callbacks = 0;
    await assert.rejects(
      store.selectFinal90Once(first.sealedHandle, async () => {
        callbacks += 1;
      }),
      (error) => sealedFailureCode(error) === "SEALED_CRYPTO_FAILED"
    );
    assert.equal(callbacks, 0);
  });

  await withRoot("muse-sealed-private-mode-", async (root) => {
    const store = createSealedQualificationStore(root);
    const sealed = await store.sealPoolOnce({
      metadata: { qualification: "private-mode" },
      pool: makePool180("private-mode"),
      priorPayloads: []
    });
    const envelopePath = join(root, "pool-" + sealed.poolHash + ".envelope");
    await chmod(envelopePath, 0o644);
    let callbacks = 0;
    await assert.rejects(
      store.selectFinal90Once(sealed.sealedHandle, async () => {
        callbacks += 1;
      }),
      (error) => sealedFailureCode(error) === "SEALED_SEAL_IO_FAILED"
    );
    assert.equal(callbacks, 0);
  });

  await withRoot("muse-sealed-private-symlink-", async (root) => {
    const store = createSealedQualificationStore(root);
    const sealed = await store.sealPoolOnce({
      metadata: { qualification: "private-symlink" },
      pool: makePool180("private-symlink"),
      priorPayloads: []
    });
    const claimPath = join(root, "pool-" + sealed.poolHash + ".claim");
    const targetPath = join(root, "attacker-controlled-claim");
    await writeFile(targetPath, "{}", { mode: 0o600 });
    await rm(claimPath, { force: true });
    await symlink(targetPath, claimPath);
    let callbacks = 0;
    await assert.rejects(
      store.selectFinal90Once(sealed.sealedHandle, async () => {
        callbacks += 1;
      }),
      (error) => sealedFailureCode(error) === "SEALED_SEAL_IO_FAILED"
    );
    assert.equal(callbacks, 0);
  });

  await withRoot("muse-sealed-registry-mode-", async (root) => {
    const store = createSealedQualificationStore(root);
    await store.sealPoolOnce({
      metadata: { qualification: "registry-mode" },
      pool: makePool180("registry-mode"),
      priorPayloads: []
    });
    await chmod(join(root, "registry.jsonl"), 0o644);
    await assert.rejects(
      store.inspect(),
      (error) => sealedFailureCode(error) === "SEALED_LEDGER_IO_FAILED"
    );
  });
});

test("reconciliation burns reproduction claim-only crashes and reproduction-consuming orphans", async () => {
  await withRoot("muse-sealed-repro-claim-crash-", async (root) => {
    const store = createSealedQualificationStore(root);
    const sealed = await store.sealPoolOnce({
      metadata: { qualification: "repro-claim-crash" },
      pool: makePool180("repro-claim-crash"),
      priorPayloads: []
    });
    const passed = await store.selectFinal90Once(sealed.sealedHandle, async () => {});
    const probe = await openFile(join(root, "prototype-probe"), "wx", 0o600);
    const prototype = Object.getPrototypeOf(probe);
    const originalWriteFile = prototype.writeFile;
    await probe.close();
    await rm(join(root, "prototype-probe"), { force: true });
    let callbacks = 0;
    prototype.writeFile = async function failReproductionConsuming(data, ...args) {
      const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      if (text.includes('"status":"reproduction-consuming"')) {
        throw new Error("injected-reproduction-claim-only-crash");
      }
      return originalWriteFile.call(this, data, ...args);
    };
    try {
      await assert.rejects(
        store.reproducePassedOnce(passed.passedHandle, async () => {
          callbacks += 1;
        }),
        (error) => sealedFailureCode(error) === "SEALED_LEDGER_IO_FAILED"
      );
    } finally {
      prototype.writeFile = originalWriteFile;
    }
    assert.equal(callbacks, 0);
    assert.equal((await store.inspect()).pools[0].status, "passed");
    assert.equal((await store.reconcile()).burnedCount, 1);
    assert.equal((await store.inspect()).pools[0].status, "burned");
  });

  await withRoot("muse-sealed-repro-consuming-crash-", async (root) => {
    const store = createSealedQualificationStore(root);
    const sealed = await store.sealPoolOnce({
      metadata: { qualification: "repro-consuming-crash" },
      pool: makePool180("repro-consuming-crash"),
      priorPayloads: []
    });
    const passed = await store.selectFinal90Once(sealed.sealedHandle, async () => {});
    const probe = await openFile(join(root, "prototype-probe"), "wx", 0o600);
    const prototype = Object.getPrototypeOf(probe);
    const originalWriteFile = prototype.writeFile;
    await probe.close();
    await rm(join(root, "prototype-probe"), { force: true });
    prototype.writeFile = async function failReproducedTerminal(data, ...args) {
      const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      if (text.includes('"status":"reproduced"')) {
        throw new Error("injected-reproduction-terminal-crash");
      }
      return originalWriteFile.call(this, data, ...args);
    };
    try {
      await assert.rejects(
        store.reproducePassedOnce(passed.passedHandle, async () => {}),
        (error) => sealedFailureCode(error) === "SEALED_LEDGER_IO_FAILED"
      );
    } finally {
      prototype.writeFile = originalWriteFile;
    }
    assert.equal((await store.inspect()).pools[0].status, "reproduction-consuming");
    assert.equal((await store.reconcile()).burnedCount, 1);
    assert.equal((await store.inspect()).pools[0].status, "burned");
  });
});

test("durable claim and ledger writes fsync the file and parent before network work", async () => {
  await withRoot("muse-sealed-fsync-order-", async (root) => {
    const probe = await openFile(join(root, "prototype-probe"), "wx", 0o600);
    const prototype = Object.getPrototypeOf(probe);
    const originalWriteFile = prototype.writeFile;
    const originalSync = prototype.sync;
    await probe.close();
    await rm(join(root, "prototype-probe"), { force: true });

    const handleKinds = new WeakMap();
    const events = [];
    prototype.writeFile = async function observeWrite(data, ...args) {
      const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      let kind = "other";
      if (text.includes('"status":"consuming"')) {
        kind = "ledger-consuming";
      } else if (text.includes('"schema":"muse-recall-selection-claim-v2"')) {
        kind = "selection-claim";
      } else if (text.includes('"status":"sealed"')) {
        kind = "ledger-sealed";
      } else if (text.includes('"schema":"muse-recall-seal-claim-v2"')) {
        kind = "seal-claim";
      }
      handleKinds.set(this, kind);
      events.push("write:" + kind);
      return originalWriteFile.call(this, data, ...args);
    };
    prototype.sync = async function observeSync(...args) {
      events.push("sync:" + (handleKinds.get(this) ?? "parent"));
      return originalSync.call(this, ...args);
    };

    try {
      const store = createSealedQualificationStore(root);
      const sealed = await store.sealPoolOnce({
        metadata: { qualification: "fsync-order" },
        pool: makePool180("fsync-order"),
        priorPayloads: []
      });
      await store.selectFinal90Once(sealed.sealedHandle, async () => {
        events.push("network");
      });
    } finally {
      prototype.writeFile = originalWriteFile;
      prototype.sync = originalSync;
    }

    const assertDurableBefore = (kind, boundary) => {
      const writeIndex = events.indexOf("write:" + kind);
      const fileSyncIndex = events.indexOf("sync:" + kind, writeIndex + 1);
      const parentSyncIndex = events.indexOf("sync:parent", fileSyncIndex + 1);
      const boundaryIndex = events.indexOf(boundary, parentSyncIndex + 1);
      assert.ok(writeIndex >= 0, "missing write for " + kind);
      assert.ok(fileSyncIndex > writeIndex, "missing file fsync for " + kind);
      assert.ok(parentSyncIndex > fileSyncIndex, "missing parent fsync for " + kind);
      assert.ok(boundaryIndex > parentSyncIndex, "boundary preceded durability for " + kind);
    };
    assertDurableBefore("seal-claim", "write:ledger-sealed");
    assertDurableBefore("ledger-sealed", "write:selection-claim");
    assertDurableBefore("selection-claim", "write:ledger-consuming");
    assertDurableBefore("ledger-consuming", "network");
  });
});

test("a dead cross-process mutation lock is recovered without admitting concurrent mutation", async () => {
  await withRoot("muse-sealed-dead-lock-", async (root) => {
    await writeFile(
      join(root, ".mutation.lock"),
      JSON.stringify({
        pid: 2_147_483_647,
        schema: "muse-recall-mutation-lock-v2",
        token: "0".repeat(32)
      }),
      { mode: 0o600 }
    );
    const store = createSealedQualificationStore(root);
    const state = await store.inspect();
    assert.equal(state.entries, 0);
    assert.equal(state.headHash, "0".repeat(64));
    assert.equal(
      (await readdir(root)).some((name) =>
        name === ".mutation.lock" || name.startsWith(".dead-lock-")
      ),
      false
    );
  });
});

test("a partially published mutation lock is treated as bounded contention", async () => {
  await withRoot("muse-sealed-partial-lock-", async (root) => {
    const lockPath = join(root, ".mutation.lock");
    await writeFile(lockPath, "", { mode: 0o600 });
    const release = delay(20).then(() => rm(lockPath, { force: true }));
    try {
      const state = await createSealedQualificationStore(root).inspect();
      assert.equal(state.entries, 0);
      assert.equal(state.headHash, "0".repeat(64));
    } finally {
      await release;
    }
  });
});

test("a persistently malformed mutation lock fails closed after bounded retries", async () => {
  await withRoot("muse-sealed-malformed-lock-", async (root) => {
    const lockPath = join(root, ".mutation.lock");
    await writeFile(lockPath, "{", { mode: 0o600 });
    const startedAt = Date.now();
    await assert.rejects(
      createSealedQualificationStore(root).inspect(),
      (error) => sealedFailureCode(error) === "SEALED_LOCK_FAILED"
    );
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs >= 2_000, `lock retries ended too early: ${elapsedMs.toString()}ms`);
    assert.ok(elapsedMs < 10_000, `lock retries exceeded bound: ${elapsedMs.toString()}ms`);
    assert.equal(await readFile(lockPath, "utf8"), "{");
    assert.deepEqual(await readdir(root), [".mutation.lock"]);
  });
});
