import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ROLLBACK_BASELINE_HEAD,
  buildGovernanceBlockers,
  evidenceFileDescriptor,
  extractRollbackBaseline,
  monitorInputBindingsMatch,
  sha256,
  writeExclusiveEvidence
} from "./lib/personal-agent-successor-evidence.mjs";

test("successor rollback baseline stays on the authoritative verified commit", () => {
  const roadmap = readFileSync(
    new URL("../internal/goals/personal-agent-successor-roadmap.md", import.meta.url),
    "utf8"
  );
  assert.equal(ROLLBACK_BASELINE_HEAD, "926c01738b9be9a8b1c3668ec61c2b66d17dce63");
  assert.equal(extractRollbackBaseline(roadmap), ROLLBACK_BASELINE_HEAD);
  const changedClause = roadmap.replace(
    `The rollback baseline is the normal \`origin/main\` at \`${ROLLBACK_BASELINE_HEAD}\`.`,
    "The rollback baseline is the normal `origin/main` at `0000000000000000000000000000000000000000`."
  );
  assert.equal(
    extractRollbackBaseline(changedClause),
    "0000000000000000000000000000000000000000"
  );
  assert.notEqual(extractRollbackBaseline(changedClause), ROLLBACK_BASELINE_HEAD);
  const decoy = `Rollback baseline은 \`${ROLLBACK_BASELINE_HEAD}\`의 normal \`origin/main\`이다.\n\n${changedClause}`;
  assert.equal(
    extractRollbackBaseline(decoy),
    "0000000000000000000000000000000000000000"
  );
  assert.throws(
    () => extractRollbackBaseline(
      `\`\`\`md\n## Current blockers and rollback\nThe rollback baseline is the normal \`origin/main\` at \`${ROLLBACK_BASELINE_HEAD}\`.\n\`\`\`\n\n## Some other section\n`
    ),
    /authoritative rollback section is missing/u
  );
});

test("retained evidence receipts are exclusive, hash-bound, and mode 0600", () => {
  const root = mkdtempSync(join(tmpdir(), "muse-successor-evidence-"));
  const evidenceRoot = join(root, "evidence");
  mkdirSync(evidenceRoot, { mode: 0o700 });
  const output = join(evidenceRoot, "receipt.log");
  const bytes = Buffer.from("terminal output\n", "utf8");
  writeExclusiveEvidence(output, bytes, evidenceRoot);
  assert.deepEqual(evidenceFileDescriptor(output), {
    byteSize: bytes.byteLength,
    name: "receipt.log",
    sha256: sha256(bytes)
  });
  assert.equal(statSync(output).mode & 0o777, 0o600);
  assert.throws(() => writeExclusiveEvidence(output, bytes, evidenceRoot), /EEXIST/u);
  assert.throws(
    () => writeExclusiveEvidence(join(root, "outside.log"), bytes, evidenceRoot),
    /boundary is unsafe/u
  );
});

test("governance blockers are derived from current non-green inputs", () => {
  const blockers = buildGovernanceBlockers({
    qualification: {
      gates: [
        { id: "capability", status: "failed" },
        { id: "delivery-safety", status: "unverified", evidence: { deliveryBrake: "engaged" } }
      ]
    },
    s003: { releaseDecision: { remainingUnclassified: 473 } },
    s004: {
      queues: {
        followups: { overdue: { count: 26 } },
        reminders: { overdue: { count: 5 } }
      }
    },
    s005: {
      package: { installable: false },
      signatureAvailability: { candidateDetached: "absent", commit: "unverified" }
    },
    s006: { effects: { realLaunchctl: 0, login: 0, reboot: 0 } },
    s007: { decision: { organicEffectiveness: "not-proven" } }
  });
  assert.deepEqual(blockers, [
    "capability-axis-owner-idle-confirmation-required",
    "capability-report-failed",
    "delivery-brake-engaged-with-overdue-queues",
    "release-findings-unclassified",
    "source-signature-unverified",
    "candidate-signature-absent",
    "installable-package-definition-missing",
    "real-login-reboot-service-manager-proof-missing",
    "organic-personal-effectiveness-not-proven"
  ]);
});

test("historical organic monitor inputs must match its hashed preimage", () => {
  const monitor = {
    inputHashPreimage: {
      controlledJourneySha256: "a",
      legacyQualificationSha256: "b",
      trackedEvidenceSha256: "c"
    },
    inputs: {
      controlledJourney: { sha256: "a" },
      legacyQualification: { sha256: "b" },
      trackedEvidence: { sha256: "c" }
    }
  };
  assert.equal(monitorInputBindingsMatch(monitor), true);
  assert.equal(monitorInputBindingsMatch({
    ...monitor,
    inputs: {
      ...monitor.inputs,
      controlledJourney: { sha256: "b" },
      legacyQualification: { sha256: "a" }
    }
  }), false);
});
