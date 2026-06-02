import type { GroundingEvalCorpus } from "@muse/agent-core";

/**
 * Bundled, held-out corpus for `muse doctor --grounding` and the
 * verify-faithfulness-rate battery — a small personal note set (the kind you'd
 * never paste into a cloud LLM) plus labelled cases:
 *  - `answerable`: the fact IS in the corpus; a faithful cited answer must verify grounded.
 *  - `refuse`:     the fact is NOT here; the retrieval gate must stay non-confident.
 *  - `drift`:      an unfaithful answer (fabricated citation / unsupported specifics)
 *                  the deterministic rubric must catch as ungrounded.
 *
 * Calibrated against the real local stack (nomic-embed-text + the RGV gate) so
 * the honest current edge clears the shipped thresholds; it is the regression
 * baseline, not an aspirational target.
 */
export const GROUNDING_EVAL_CORPUS: GroundingEvalCorpus = {
  notes: [
    { source: "policy-2025.pdf", text: "Home insurance policy 7741-A: annual premium 840,000 KRW, renewal date 2026-09-14, deductible 300,000 KRW." },
    { source: "meeting-q3.md", text: "Q3 launch sync: Jin owns the deck, Mina owns pricing. Decision: ship the beta on the 12th, no marketing push until the deck is reviewed." },
    { source: "doctor.md", text: "Dentist said the 6-month cleaning is due; rebook window opens the first week of June." },
    { source: "vpn-wireguard.md", text: "Office VPN fix: set MTU to 1380 on the wg0 interface and restart wireguard to stop the handshake timeout." },
    { source: "car-maintenance.md", text: "Car log: next oil change due at 95,000 km, rotate the tires every 10,000 km, registration renews March 2027." },
    { source: "lease.md", text: "Apartment lease: monthly rent 1,250,000 KRW due on the 1st, landlord is Mr. Park, lease ends 2027-02-28." },
    { source: "contacts-sarah.md", text: "Sarah Chen — product designer at Foundry, email sarah.chen@foundry.io, prefers Signal for quick pings." },
    { source: "wifi.md", text: "Home network: wifi SSID is Nest-5G, the password rotates quarterly, router admin page at 192.168.0.1." },
    { source: "gym.md", text: "Gym membership: 89,000 KRW per month, locker number 214, renews automatically on the 5th." },
    { source: "passport.md", text: "Passport expires 2029-11-03; the number is kept in the safe, renewal needs two photos." },
    { source: "recipes-curry.md", text: "Weeknight curry: 2 tablespoons garam masala, simmer 25 minutes, serves 4." },
    { source: "project-deadlines.md", text: "Project: the migration plan is due Friday, code freeze on the 20th, Alice owns the rollback runbook." }
  ],
  cases: [
    // answerable — a faithful, cited answer must verify GROUNDED
    { kind: "answerable", query: "when does my home insurance renew?", answer: "Your home insurance renews on 2026-09-14 [from policy-2025.pdf].", note: "insurance renewal date" },
    { kind: "answerable", query: "who owns pricing for the Q3 launch?", answer: "Mina owns pricing for the Q3 launch [from meeting-q3.md].", note: "launch pricing owner" },
    { kind: "answerable", query: "what MTU did I set for the office VPN?", answer: "You set the MTU to 1380 on the wg0 interface for the office VPN [from vpn-wireguard.md].", note: "VPN MTU value" },
    { kind: "answerable", query: "what is my monthly rent?", answer: "Your monthly rent is 1,250,000 KRW, due on the 1st [from lease.md].", note: "monthly rent" },
    { kind: "answerable", query: "what is Sarah's email address?", answer: "Sarah Chen's email is sarah.chen@foundry.io [from contacts-sarah.md].", note: "contact email" },
    { kind: "answerable", query: "when is the dentist cleaning due?", answer: "Your dentist cleaning is due; the rebook window opens the first week of June [from doctor.md].", note: "dentist cleaning" },
    { kind: "answerable", query: "at what mileage is my next oil change?", answer: "Your next oil change is due at 95,000 km [from car-maintenance.md].", note: "oil change mileage" },
    { kind: "answerable", query: "what is my home wifi SSID?", answer: "Your home wifi SSID is Nest-5G [from wifi.md].", note: "wifi ssid" },
    { kind: "answerable", query: "how much is my gym membership per month?", answer: "Your gym membership is 89,000 KRW per month [from gym.md].", note: "gym fee" },
    { kind: "answerable", query: "when does my passport expire?", answer: "Your passport expires on 2029-11-03 [from passport.md].", note: "passport expiry" },
    { kind: "answerable", query: "when is the migration plan due?", answer: "The migration plan is due Friday [from project-deadlines.md].", note: "migration deadline" },
    { kind: "answerable", query: "how long do I simmer the weeknight curry?", answer: "Simmer the weeknight curry for 25 minutes [from recipes-curry.md].", note: "curry simmer time" },

    // refuse — the fact isn't in the corpus; the gate must NOT go confident
    { kind: "refuse", query: "what is my blood type?", note: "no medical record" },
    { kind: "refuse", query: "what is my mother's maiden name?", note: "no family record" },
    { kind: "refuse", query: "how much did I spend on groceries last month?", note: "no spending log" },
    { kind: "refuse", query: "what is my streaming account password?", note: "no credential note" },
    { kind: "refuse", query: "when is my next flight departure?", note: "no travel itinerary" },
    { kind: "refuse", query: "what was the name of my childhood pet?", note: "no personal history note" },
    { kind: "refuse", query: "what time is my haircut appointment this week?", note: "no appointment" },
    { kind: "refuse", query: "what is the boiling point of mercury in kelvin?", note: "encyclopedic, out of personal scope" },

    // drift — an UNFAITHFUL answer the gate must catch as ungrounded
    { kind: "drift", query: "what MTU for the office VPN?", answer: "The office VPN uses MTU 1380 [from network-secrets.md].", note: "fabricated citation to a non-existent source" },
    { kind: "drift", query: "who owns pricing?", answer: "Mina owns pricing and the budget was approved at 2,000,000 KRW [from finance-2025.md].", note: "fabricated citation + unsupported budget" },
    { kind: "drift", query: "when is the dentist cleaning?", answer: "Your dentist cleaning is confirmed for June 3rd at 2:30 PM with Dr. Kim in room 4B; bring your insurance card and arrive 15 minutes early [from doctor.md].", note: "unsupported specifics drown the evidence (coverage floor)" },
    { kind: "drift", query: "what is my rent?", answer: "Your rent is 1,250,000 KRW, auto-transferred from Shinhan account 110-234-556789 with a 50,000 KRW late fee after the 5th, managed by Sunrise Property Co [from lease.md].", note: "right number, fabricated account/fee details (coverage floor)" },
    { kind: "drift", query: "what is my blood type?", answer: "Your blood type is O positive [from medical-records.md].", note: "off-corpus answer with a fabricated citation" },

    // wrong-VALUE drift — confident retrieval, every token but the number is in
    // the evidence, so the lexical rubric reads `grounded`; only claim-level value
    // escalation catches the fabricated number. WITHOUT it these slip and
    // faithfulness drops below the floor — so this corpus now GUARDS that fix.
    { kind: "drift", query: "what MTU did I set for the office VPN?", answer: "You set the MTU to 9000 on the wg0 interface for the office VPN [from vpn-wireguard.md].", note: "wrong VALUE 9000 vs evidence 1380 — only the number is fabricated" },
    { kind: "drift", query: "what is my monthly rent?", answer: "Your monthly rent is 1,500,000 KRW, due on the 1st [from lease.md].", note: "wrong VALUE 1,500,000 vs evidence 1,250,000" }
  ]
};
