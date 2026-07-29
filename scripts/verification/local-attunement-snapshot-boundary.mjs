/* global Buffer, console */

/**
 * Standalone boundary proof for the provider-observed configured-local
 * Attunement snapshot. Run after building @muse/attunement:
 *
 *   pnpm --filter @muse/attunement build
 *   node scripts/verification/local-attunement-snapshot-boundary.mjs
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LocalAttunementSnapshotProviderError,
  createLocalAttunementSnapshotProvider
} from "../../packages/attunement/dist/host.js";
import {
  LocalAttunementSnapshotReceiptError,
  verifyLocalAttunementSnapshotReceiptIntegrity,
  verifyMintedLocalAttunementSnapshotCapture
} from "../../packages/attunement/dist/continuity-snapshots.js";

const AT = "2026-07-30T00:00:00.000Z";
const CANARY = `PRIVATE_SNAPSHOT_CANARY_${randomUUID()}`;
const SOURCE_ID = "local-default";
const THREAD_ID = "thread_planning";

function assert(condition, label) {
  if (!condition) throw new Error(`ASSERT FAILED: ${label}`);
  console.log(`  ✓ ${label}`);
}

async function expectRejects(operation, expected, label) {
  try {
    await operation();
  } catch (error) {
    assert(error instanceof expected.type, `${label}: preserves the public error class`);
    assert(error.code === expected.code, `${label}: exposes ${expected.code}`);
    assert(
      error.details?.reason === expected.reason && error.details?.path === expected.path,
      `${label}: preserves bounded ${expected.reason} details`
    );
    return;
  }
  throw new Error(`ASSERT FAILED: ${label}: expected rejection`);
}

function attunementState() {
  return {
    deliveries: [],
    interactionReceipts: [],
    nextPolicyVersion: 1,
    resetReceipts: [],
    schemaVersion: 11,
    threads: [{
      createdAt: "2026-07-29T00:00:00.000Z",
      id: THREAD_ID,
      kind: "work",
      links: [],
      policy: {
        detail: "standard",
        nextStep: "direct",
        suppression: "none",
        version: 0
      },
      title: CANARY
    }],
    undoResetReceipts: []
  };
}

const directory = await mkdtemp(join(tmpdir(), "muse-local-snapshot-verifier-"));
const attunementFile = join(directory, "attunement.json");
const missingFile = join(directory, "not-created.json");

try {
  await writeFile(attunementFile, `${JSON.stringify(attunementState())}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  const filesBefore = await readdir(directory);

  console.log("1) public host capture from a real local Attunement file");
  const provider = createLocalAttunementSnapshotProvider({
    attunementFile,
    clock: () => new Date(AT),
    sourceId: SOURCE_ID
  });
  const capture = await provider.capture({ sourceId: SOURCE_ID, threadId: THREAD_ID });
  assert(capture.status === "available", "configured file yields an available snapshot");
  if (capture.status !== "available") throw new Error("available snapshot was required");
  assert(capture.receipt.captureCompletedAt === AT, "receipt records the fixed terminal instant");
  assert(capture.receipt.authority === "receipt-integrity-only", "receipt makes no stronger authority claim");
  assert(capture.receipt.freshness.status === "unassessed", "receipt leaves freshness unassessed");
  assert(capture.receipt.coverage.canAssertAbsenceWithinSnapshot === false, "receipt refuses snapshot absence claims");
  assert(capture.receipt.coverage.canAssertCurrentWorldAbsence === false, "receipt refuses current-world absence claims");
  assert(
    capture.receipt.stateDigest === `sha256:${createHash("sha256").update(capture.normalizedStateJson, "utf8").digest("hex")}`,
    "receipt digest binds the returned normalized state"
  );
  assert(
    capture.receipt.normalizedStateBytes === Buffer.byteLength(capture.normalizedStateJson, "utf8"),
    "receipt byte count binds the returned normalized state"
  );
  assert(JSON.parse(capture.normalizedStateJson).threads[0]?.title === CANARY, "canary is available only by direct state access");

  console.log("2) public verification separates receipt integrity from local minting");
  const verifiedReceipt = verifyLocalAttunementSnapshotReceiptIntegrity(capture.receipt);
  assert(verifiedReceipt.receiptId === capture.receipt.receiptId, "receipt integrity verifies through the public snapshot subpath");
  assert(verifyMintedLocalAttunementSnapshotCapture(capture) === capture, "original process-local capture verifies as minted");
  const receiptClone = JSON.parse(JSON.stringify(capture.receipt));
  assert(
    verifyLocalAttunementSnapshotReceiptIntegrity(receiptClone).receiptId === capture.receipt.receiptId,
    "serializable receipt clone retains integrity only"
  );
  const reconstructed = {
    normalizedStateJson: capture.normalizedStateJson,
    provenance: capture.provenance,
    receipt: receiptClone,
    status: capture.status
  };
  await expectRejects(
    () => verifyMintedLocalAttunementSnapshotCapture(reconstructed),
    {
      code: "UNTRUSTED_CAPTURE",
      path: "/",
      reason: "not-minted",
      type: LocalAttunementSnapshotReceiptError
    },
    "JSON reconstruction"
  );

  console.log("3) scope admission fails closed before a source outcome can be published");
  const mismatchProvider = createLocalAttunementSnapshotProvider({
    attunementFile: missingFile,
    clock: () => new Date(AT),
    sourceId: SOURCE_ID
  });
  await expectRejects(
    () => mismatchProvider.capture({ sourceId: "another-source", threadId: THREAD_ID }),
    {
      code: "INVALID_SCOPE",
      path: "/scope/sourceId",
      reason: "source-id-mismatch",
      type: LocalAttunementSnapshotProviderError
    },
    "source mismatch"
  );

  console.log("4) routine serialization does not leak configured path or personal state");
  const serializedCapture = JSON.stringify(capture);
  const serializedReceipt = JSON.stringify(capture.receipt);
  assert(!Object.keys(capture).includes("normalizedStateJson"), "state field is non-enumerable");
  assert(!serializedCapture.includes(CANARY), "capture JSON excludes the private-state canary");
  assert(!serializedCapture.includes(attunementFile), "capture JSON excludes the configured path");
  assert(!serializedReceipt.includes(CANARY), "receipt JSON excludes the private-state canary");
  assert(!serializedReceipt.includes(attunementFile), "receipt JSON excludes the configured path");

  console.log("5) a missing configured file abstains without asserting absence");
  const missingCapture = await createLocalAttunementSnapshotProvider({
    attunementFile: missingFile,
    clock: () => new Date(AT),
    sourceId: SOURCE_ID
  }).capture({ sourceId: SOURCE_ID, threadId: THREAD_ID });
  assert(missingCapture.status === "abstained", "missing source abstains");
  if (missingCapture.status !== "abstained") throw new Error("abstention was required");
  assert(missingCapture.receipt.reason === "requested-scope-unavailable", "missing source uses the conservative unavailable reason");
  assert(missingCapture.receipt.coverage.canAssertAbsenceWithinSnapshot === false, "missing source does not assert snapshot absence");
  assert(missingCapture.receipt.coverage.canAssertCurrentWorldAbsence === false, "missing source does not assert current-world absence");
  assert(!Object.hasOwn(missingCapture, "normalizedStateJson"), "abstention contains no normalized state");
  assert(!JSON.stringify(missingCapture).includes(missingFile), "abstention serialization excludes the configured path");
  assert(
    verifyLocalAttunementSnapshotReceiptIntegrity(missingCapture.receipt).status === "abstained",
    "abstention receipt retains public integrity verification"
  );
  assert(
    JSON.stringify(await readdir(directory)) === JSON.stringify(filesBefore),
    "Provider capture creates no durable file or cache"
  );

  console.log("\nlocal Attunement snapshot boundary verifier PASS");
} finally {
  await rm(directory, { force: true, recursive: true });
}
