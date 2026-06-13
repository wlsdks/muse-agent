// Differentiation proof battery — the recipient of an outbound action is RESOLVED,
// never GUESSED. (L7 widening: outbound-safety rule 3.)
//
// A wrong autonomous send is a message the user never wrote arriving in the wrong
// person's inbox — irreversible. outbound-safety.md rule 3: "the destination must
// resolve unambiguously; an ambiguous or unknown recipient triggers a clarifying
// question (the clarify-directive) — never a best-guess address." resolveContact
// (@muse/mcp) enforces it deterministically: a single exact/partial match resolves
// to that one person, MULTIPLE matches return `ambiguous` with ALL candidates (it
// never silently picks one), and no match / an empty query returns `unknown` (it
// never invents a recipient). The relationship field ("manager", "wife") is NOT an
// identifier and can't resolve a recipient.
//
// Rivals act on the world autonomously: "message Alex" with two Alexes is exactly
// the best-match guess a throughput agent makes. Muse returns ambiguous → clarify,
// so the user — not the model — picks who actually receives the send.
//
// This battery drives the REAL resolveContact — deterministic, no Ollama.
//
// Run: pnpm eval:recipient-resolution   (builds @muse/mcp first via package.json)

import { resolveContact, contactIdentifier } from "../packages/mcp/dist/index.js";

let failures = 0;
function check(label, cond) {
  console[cond ? "log" : "error"](`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures += 1;
}

const c = (id, name, extra = {}) => ({ id, name, ...extra });
const contacts = [
  c("1", "Alex Kim", { email: "alex.kim@example.com", relationship: "manager" }),
  c("2", "Alex Park", { email: "alex.park@example.com" }),
  c("3", "Bob Lee", { handle: "@boblee", phone: "+1 415 555 0101" })
];

// ── 1. A unique exact match RESOLVES to that one person ──────────────────────
{
  const r = resolveContact(contacts, "Bob Lee");
  check("a unique name ⇒ resolved to the one person", r.status === "resolved" && r.contact.id === "3");
  check("...and its identifier is the REAL recorded address (never invented)", contactIdentifier(r.contact) === "@boblee");
}

// ── 2. Multiple matches ⇒ AMBIGUOUS — every candidate, NEVER a best-guess pick ─
{
  const r = resolveContact(contacts, "Alex");
  check("two people named Alex ⇒ ambiguous (NOT a silently-guessed recipient)", r.status === "ambiguous");
  check("...and ALL candidates are surfaced for the user to pick (2)", r.status === "ambiguous" && r.matches.length === 2);
}

// ── 3. No match ⇒ UNKNOWN — a recipient is never invented ────────────────────
{
  const r = resolveContact(contacts, "Charlie Nguyen");
  check("an unknown name ⇒ unknown (no recipient invented)", r.status === "unknown");
}

// ── 4. An empty/whitespace query ⇒ UNKNOWN (no accidental match) ──────────────
{
  check("an empty query ⇒ unknown", resolveContact(contacts, "   ").status === "unknown");
}

// ── 5. Resolution works by EMAIL / HANDLE / PHONE, not just name ──────────────
{
  check("resolve by email ⇒ the matching person", resolveContact(contacts, "alex.park@example.com").status === "resolved");
  check("resolve by @handle ⇒ the matching person", resolveContact(contacts, "@boblee").contact?.id === "3");
}

// ── 6. The relationship field is NOT an identifier — it can't resolve a recipient
{
  // "manager" is Alex Kim's relationship, but it must never resolve a send target.
  const r = resolveContact(contacts, "manager");
  check("a relationship word ('manager') does NOT resolve a recipient", r.status === "unknown");
}

if (failures > 0) {
  console.error(`\n[eval:recipient-resolution] FAIL — ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\n[eval:recipient-resolution] PASS — the recipient is resolved, never guessed: one match resolves, multiple ⇒ ambiguous (all candidates, the user picks), no match ⇒ unknown, relationship is not an identifier");
