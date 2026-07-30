import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";

export const ROLLBACK_BASELINE_HEAD = "926c01738b9be9a8b1c3668ec61c2b66d17dce63";
const ROLLBACK_BASELINE_CLAUSE =
  /^Rollback baseline은 `([0-9a-f]{40})`의 normal `origin\/main`이다\.$/u;

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function extractRollbackBaseline(roadmapText) {
  let fence;
  let inSection = false;
  let sectionFound = false;
  const matches = [];
  for (const line of roadmapText.split(/\r?\n/u)) {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/u);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence) continue;
    if (/^##[ \t]+/u.test(line)) {
      if (line.trim() === "## 현재 blocker와 rollback") {
        if (sectionFound) throw new Error("authoritative rollback section is ambiguous");
        sectionFound = true;
        inSection = true;
      } else if (inSection) {
        inSection = false;
      }
      continue;
    }
    if (!inSection) continue;
    const match = line.match(ROLLBACK_BASELINE_CLAUSE);
    if (match) matches.push(match);
  }
  if (!sectionFound) throw new Error("authoritative rollback section is missing");
  if (matches.length !== 1) {
    throw new Error("authoritative rollback baseline clause is missing or ambiguous");
  }
  return matches[0][1];
}

function requireEvidenceOutput(path, evidenceRoot) {
  const root = realpathSync(evidenceRoot);
  const parent = realpathSync(dirname(path));
  const canonicalPath = join(parent, basename(path));
  const rel = relative(root, canonicalPath);
  if (
    parent !== root
    || rel === ""
    || rel === ".."
    || rel.startsWith(`..${sep}`)
    || lstatSync(root).isSymbolicLink()
  ) {
    throw new Error("successor evidence output boundary is unsafe");
  }
}

export function writeExclusiveEvidence(path, bytes, evidenceRoot) {
  requireEvidenceOutput(path, evidenceRoot);
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  chmodSync(path, 0o600);
}

export function evidenceFileDescriptor(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("successor evidence receipt must reference a regular file");
  }
  const bytes = readFileSync(path);
  return {
    byteSize: bytes.byteLength,
    name: basename(path),
    sha256: sha256(bytes)
  };
}

export function monitorInputBindingsMatch(monitor) {
  return [
    ["controlledJourney", "controlledJourneySha256"],
    ["legacyQualification", "legacyQualificationSha256"],
    ["trackedEvidence", "trackedEvidenceSha256"]
  ].every(([inputKey, preimageKey]) => (
    typeof monitor.inputs?.[inputKey]?.sha256 === "string"
    && monitor.inputs[inputKey].sha256 === monitor.inputHashPreimage?.[preimageKey]
  ));
}

export function buildGovernanceBlockers({ qualification, s003, s004, s005, s006, s007 }) {
  const capability = qualification.gates.find((gate) => gate.id === "capability");
  const delivery = qualification.gates.find((gate) => gate.id === "delivery-safety");
  const blockers = ["capability-axis-owner-idle-confirmation-required"];
  if (capability?.status !== "passed") blockers.push("capability-report-failed");
  if (
    delivery?.evidence?.deliveryBrake === "engaged"
    && (
      s004.queues.followups.overdue.count > 0
      || s004.queues.reminders.overdue.count > 0
    )
  ) blockers.push("delivery-brake-engaged-with-overdue-queues");
  if (s003.releaseDecision.remainingUnclassified > 0) blockers.push("release-findings-unclassified");
  if (s005.signatureAvailability.commit !== "verified") blockers.push("source-signature-unverified");
  if (s005.signatureAvailability.candidateDetached !== "verified") blockers.push("candidate-signature-absent");
  if (s005.package.installable !== true) blockers.push("installable-package-definition-missing");
  if (
    s006.effects.realLaunchctl !== 1
    || s006.effects.login !== 1
    || s006.effects.reboot !== 1
  ) blockers.push("real-login-reboot-service-manager-proof-missing");
  if (s007.decision.organicEffectiveness !== "proven") {
    blockers.push("organic-personal-effectiveness-not-proven");
  }
  return blockers;
}
