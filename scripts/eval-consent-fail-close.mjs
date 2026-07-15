// Differentiation proof battery — an outbound action toward a third party is
// FAIL-CLOSED: absent consent, a scope/host mismatch, a recorded veto, or a
// timeout produces NO external effect (the credential never leaves), and only a
// recorded, scope+host-matched consent lets the request go.
//
// outbound-safety.md is a non-negotiable contract: "deny / timeout /
// ambiguous-recipient / absent-consent produces no external effect (contract-
// faithful HTTP fake, never a fake registry)". performConsentedAction (@muse/mcp)
// enforces it deterministically: a veto (checked first) overrides prior consent,
// no recorded consent means the credential is never resolved and no request is
// made, a consent bound to allowedHost refuses a different host (credential can't
// be exfiltrated to a caller-controlled URL), and a hung endpoint times out
// bounded. Rivals' value prop is AUTONOMY — hermes/openclaw act on the world on
// the model's judgement; a fail-closed, recorded-scoped-consent gate over every
// standing-objective send is off-brand cost for a throughput agent. For a
// single-user "a wrong autonomous send is a message your user did not write
// arriving in someone else's inbox" assistant it IS the contract.
//
// This battery drives the REAL performConsentedAction with a contract-faithful
// fetch fake (records calls; never a real network) — deterministic, no Ollama.
//
// Run: pnpm eval:consent-fail-close   (builds @muse/mcp first via package.json)

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { performConsentedAction, recordConsent, recordVeto } from "../packages/mcp/dist/index.js";

let failures = 0;
function check(label, cond) {
  console[cond ? "log" : "error"](`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures += 1;
}

const dir = mkdtempSync(join(tmpdir(), "muse-consent-"));
const consentFile = join(dir, "consent.json");
const vetoFile = join(dir, "vetoes.json");
const CRED = "secret-scoped-token-xyz";

// Contract-faithful HTTP fake: records every call (and the bearer it carried),
// returns a Response-like {status}. A "never called" assertion = no external effect.
function fetchSpy(status = 200) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: init?.headers?.authorization });
    return { status };
  };
  return { fetchImpl, calls };
}
const base = (objectiveId, scope, request, extra = {}) => ({
  consentFile, userId: "u1", objectiveId, scope, credential: CRED, request, ...extra
});

try {
  // ── 1. No recorded consent ⇒ fail-closed, the credential never leaves ────────
  {
    const spy = fetchSpy();
    const out = await performConsentedAction(base("obj-none", "email:send", { url: "https://api.example.com/send" }, { fetchImpl: spy.fetchImpl }));
    check("no recorded consent ⇒ performed:false", out.performed === false);
    check("...and NO request is made (credential never leaves)", spy.calls.length === 0);
  }

  // ── 2. Recorded, scope+host-matched consent ⇒ the action proceeds ────────────
  {
    await recordConsent(consentFile, { id: "c1", userId: "u1", objectiveId: "obj-ok", scope: "email:send", allowedHost: "api.example.com", grantedAt: new Date().toISOString() });
    const spy = fetchSpy(201);
    const out = await performConsentedAction(base("obj-ok", "email:send", { url: "https://api.example.com/send", body: "{}" }, { fetchImpl: spy.fetchImpl }));
    check("a recorded, scope+host-matched consent ⇒ performed:true", out.performed === true && out.status === 201);
    check("...and exactly one request carried the scoped credential", spy.calls.length === 1 && spy.calls[0].auth === `Bearer ${CRED}`);
  }

  // ── 3. Scope mismatch ⇒ fail-closed (consent is never broadened implicitly) ──
  {
    const spy = fetchSpy();
    const out = await performConsentedAction(base("obj-ok", "calendar:write", { url: "https://api.example.com/x" }, { fetchImpl: spy.fetchImpl }));
    check("a DIFFERENT scope than the consent ⇒ performed:false (no implicit broadening)", out.performed === false);
    check("...and no request is made", spy.calls.length === 0);
  }

  // ── 4. Host mismatch ⇒ fail-closed, the token can't be exfiltrated ───────────
  {
    const spy = fetchSpy();
    const out = await performConsentedAction(base("obj-ok", "email:send", { url: "https://evil.example.net/steal" }, { fetchImpl: spy.fetchImpl }));
    check("a host other than the consented allowedHost ⇒ performed:false (no credential exfil)", out.performed === false);
    check("...and no request is made (token never leaves)", spy.calls.length === 0);
  }

  // ── 5. A recorded veto overrides prior consent (checked first) ───────────────
  {
    await recordConsent(consentFile, { id: "c2", userId: "u1", objectiveId: "obj-veto", scope: "email:send", allowedHost: "api.example.com", grantedAt: new Date().toISOString() });
    await recordVeto(vetoFile, { id: "v1", objectiveId: "obj-veto", scope: "email:send", userId: "u1", vetoedAt: new Date().toISOString() });
    const spy = fetchSpy();
    const out = await performConsentedAction(base("obj-veto", "email:send", { url: "https://api.example.com/send" }, { fetchImpl: spy.fetchImpl, vetoFile }));
    check("a recorded veto overrides prior consent ⇒ performed:false ('don't do this again' wins)", out.performed === false && /vetoed/u.test(out.reason));
    check("...and no request is made", spy.calls.length === 0);
  }

  // ── 6. A consented endpoint that hangs ⇒ bounded timeout, fail-closed ────────
  {
    let calls = 0;
    const hangingFetch = (_url, init) => {
      calls += 1;
      const { promise, reject } = Promise.withResolvers();
      init?.signal?.addEventListener("abort", () => {
        reject(new Error("aborted"));
      }, { once: true });
      return promise;
    };
    const out = await performConsentedAction(base("obj-ok", "email:send", { url: "https://api.example.com/send" }, { fetchImpl: hangingFetch, timeoutMs: 30 }));
    check("a hung consented endpoint ⇒ performed:false (bounded timeout, loop can't stall)", out.performed === false && /timed out/u.test(out.reason));
    void calls;
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n[eval:consent-fail-close] FAIL — ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\n[eval:consent-fail-close] PASS — outbound action is fail-closed: no consent / scope-mismatch / host-mismatch / veto / timeout makes NO external effect; only a recorded scoped consent sends");
