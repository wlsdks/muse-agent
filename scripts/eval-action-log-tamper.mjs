// Differentiation proof battery — every autonomous action is sealed into a
// TAMPER-EVIDENT hash chain, so silent edit / deletion / reorder of the agent's
// own history is detectable in code.
//
// Muse hash-chains every logged action — performed AND refused — into a
// genesis-anchored SHA-256 chain (appendActionLog sets each entry's prevHash to
// the hash of the tip). verifyActionLogChain(File) walks the log in append order
// and reports {ok, brokenAtIndex} — a single altered/deleted/reordered entry
// breaks verification at a precise index. undoLoggedAction records a durable veto
// + an accountable undo entry that EXTENDS the chain rather than breaking it.
//
// Rivals treat their action/mutation history as ordinary mutable state: hermes
// offers whole-skill snapshot/restore but no integrity check over the snapshot
// store; openclaw's Dreaming --rollback can't even undo a memory already promoted
// to MEMORY.md (community issue #62184, closed not-planned). A cloud/throughput
// product has no reason to pay for a per-action hash chain, and a "freely
// self-mutating skills/memory" pitch is structurally at odds with a
// verifiable-immutability seam over that history. For a single-user "it can't
// tell anyone, and it can't quietly rewrite what it did" assistant the chain IS
// the trust contract. This battery proves the property end-to-end with real temp
// files (no Ollama).
//
// Run: pnpm eval:action-log-tamper   (builds @muse/mcp first via package.json)

import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { undoLoggedAction } from "../packages/proactivity/dist/index.js";
import { appendActionLog, readVetoes, verifyActionLogChainFile } from "../packages/stores/dist/index.js";

let failures = 0;
function check(label, cond) {
  console[cond ? "log" : "error"](`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures += 1;
}

const dir = mkdtempSync(join(tmpdir(), "muse-actionlog-"));
const logFile = join(dir, "action-log.json");
const vetoFile = join(dir, "vetoes.json");

const stamp = (n) => new Date(Date.UTC(2026, 5, 13, 12, n, 0)).toISOString();
const add = (id, what, result, n) =>
  appendActionLog(logFile, { id, userId: "u1", when: stamp(n), what, why: "battery", result });
const entriesOnDisk = () => JSON.parse(readFileSync(logFile, "utf8")).entries;
const writeEntries = (entries) => writeFileSync(logFile, `${JSON.stringify({ entries }, null, 2)}\n`);

try {
  // ── 1. Intact chain (mix of performed + refused) verifies ───────────────────
  await add("a1", "sent email to Bob", "performed", 1);
  await add("a2", "blocked risky transfer", "refused", 2);
  await add("a3", "added a reminder", "performed", 3);
  let v = await verifyActionLogChainFile(logFile);
  check("intact mixed performed/refused chain verifies (linkedEntries=3)", v.ok && v.brokenAtIndex === null && v.linkedEntries === 3);
  check("a REFUSED (fail-closed) action is chained too — as accountable as a performed one",
    entriesOnDisk().some((e) => e.result === "refused" && typeof e.prevHash === "string"));

  const intact = readFileSync(logFile, "utf8"); // snapshot to restore between tamper cases

  // ── 2. Content tamper (the teeth): edit a NON-tip entry's `what` ─────────────
  const tampered = entriesOnDisk();
  tampered[0].what = "sent email to Eve"; // a1 silently rewritten
  writeEntries(tampered);
  v = await verifyActionLogChainFile(logFile);
  check("a one-field content edit of a logged action is CAUGHT at a precise index", !v.ok && typeof v.brokenAtIndex === "number");
  writeFileSync(logFile, intact); // restore
  check("...and the restored intact chain verifies again (the break WAS the tamper, not a flaky check)",
    (await verifyActionLogChainFile(logFile)).ok);

  // ── 3. Deletion / reorder is caught ─────────────────────────────────────────
  const deleted = entriesOnDisk();
  deleted.splice(1, 1); // remove the middle entry (a2)
  writeEntries(deleted);
  v = await verifyActionLogChainFile(logFile);
  check("a silently DELETED entry breaks the chain (brokenAtIndex set)", !v.ok && typeof v.brokenAtIndex === "number");
  const reordered = entriesOnDisk(); // (intact still on disk? no — deleted is) restore then reorder
  writeFileSync(logFile, intact);
  const swap = entriesOnDisk();
  [swap[0], swap[1]] = [swap[1], swap[0]]; // reorder a1<->a2
  writeEntries(swap);
  check("a REORDERED pair breaks the chain", !(await verifyActionLogChainFile(logFile)).ok);
  void reordered;
  writeFileSync(logFile, intact); // restore for the undo case

  // ── 4. Undo is accountable + irreversible-safe (chain stays intact) ──────────
  const res = await undoLoggedAction({
    userId: "u1", objectiveId: "obj1", scope: "email:bob", originalActionId: "a1",
    vetoFile, actionLogFile: logFile, reason: "user veto" // NO reverse fn → irreversible
  });
  check("undo of an irreversible action records a durable VETO (cannot recur)", (await readVetoes(vetoFile)).length >= 1);
  check("...and appends an accountable undo_* entry", entriesOnDisk().some((e) => e.id === "undo_a1"));
  check("...and the chain STILL verifies after the undo (correction EXTENDS the chain, never breaks it)",
    (await verifyActionLogChainFile(logFile)).ok);
  void res;

  // ── 5. No-collateral: a second user's action chains in without breaking it ───
  await add("b1", "noted a birthday", "performed", 9);
  check("appending more actions keeps the whole chain intact (no collateral)", (await verifyActionLogChainFile(logFile)).ok);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n[eval:action-log-tamper] FAIL — ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\n[eval:action-log-tamper] PASS — the action log is a tamper-evident hash chain: edit/deletion/reorder is caught, refused actions are chained, undo stays accountable");
