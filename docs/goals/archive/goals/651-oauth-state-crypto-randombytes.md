# 651 — `muse setup calendar` Google OAuth loopback flow's CSRF `state` token now uses `crypto.randomBytes(16)` instead of `Math.random().toString(36)`, and the helper is extracted to `generateOAuthState` with direct unit-test coverage

## Why

`apps/cli/src/setup-calendar.ts:runOAuthCallbackServer` runs an
ephemeral localhost HTTP server during `muse setup calendar`
to receive Google's OAuth authorization-code redirect. RFC 6749
§10.12 requires a CSRF `state` parameter to bind the callback to
the originating session — without one, an attacker who can
deliver a crafted URL to the user's loopback port could replay
their own authorization code and link the victim's Muse install
to the attacker's Google account.

Pre-fix the state was generated with:

```ts
const state = Math.random().toString(36).slice(2, 12);
```

Two problems:

1. **Math.random is not cryptographically secure**. V8's
   `Math.random` uses a non-crypto PRNG (xorshift128+). An
   attacker who observes one or two outputs from the same
   process can predict subsequent values — well-documented
   class break since 2015 (CVE-2019-9772 family). The state
   becomes guessable.
2. **Only ~52 bits of base36 entropy** in 10 characters. Even
   with a crypto-secure source, 10 base36 chars is light
   compared to the 128-bit OAuth-state convention.

**Threat model**: A second user on the same machine (or a
malicious process running as the same user) cannot read the
Muse CLI process's heap, but CAN send HTTP requests to the
loopback OAuth callback port. With `Math.random`, that second
party could:

- observe Muse-emitted state via shared-host channels
  (process listing of curl invocations, browser-emitted
  Referer logs)
- predict the next state and pre-warm an attacker-issued
  Google authorization code waiting for the loopback callback

A 128-bit `crypto.randomBytes`-derived state closes both
classes — unguessable from any number of prior outputs, and
the entropy is large enough that brute-force prediction is
infeasible.

### Defect class

**CSRF / nonce derived from non-cryptographic RNG** — first
hit. Fresh against the recent 10-iter window:

- 650: LLM timestamp sanity bound
- 649: unbounded HTTP body
- 648: HTTP fetch timeout
- 647: bracket parser inString
- 646: FIFO cap
- 645: file mode 0o600
- 644: finite guard
- 643: strict int parse
- 642: stream error listener
- 641: cacheTtlMs finite guard

None previously hit the "non-crypto RNG for a security
token" class.

## Slice

- `apps/cli/src/setup-calendar.ts`:
  - Added `import { randomBytes } from "node:crypto";`.
  - **Extracted** the state generator to a small
    `export function generateOAuthState(): string` that
    returns `randomBytes(16).toString("hex")` — 32-char
    lowercase hex, 128 bits of entropy.
  - `runOAuthCallbackServer` calls `generateOAuthState()`
    instead of the inline `Math.random().toString(36)...`.
- `apps/cli/src/setup-calendar.test.ts` (new file, direct
  unit coverage of the helper — the surrounding OAuth
  flow uses interactive prompts + a real HTTP listener,
  which can't be unit-tested cleanly; this is the
  narrowest-useful-test path):
  1. **Hex shape pinned** — `expect(state).toMatch(/^[0-9a-f]{32}$/u)`.
     Pre-fix's 10-char base36 output (e.g., `"k3j2nf9wpx"`)
     would NOT match — the mutation proof.
  2. **Distinct values across 50 samples** — pins
     `randomBytes` uniqueness (collisions in 128-bit space
     are essentially impossible).

## Verify

- `pnpm --filter @muse/cli test -- -t "generateOAuthState"`:
  2/2 passed. Full `pnpm check`: apps/api 270/270,
  apps/cli 1119/1119, every workspace green; tsc strict
  EXIT=0.
- **Clean-mutation-proven**: reverting the helper body to
  the pre-fix `Math.random().toString(36).slice(2, 12)`
  makes EXACTLY the hex-pattern test fail (the 10-char
  base36 string doesn't match `/^[0-9a-f]{32}$/u`). The
  distinct-values test passes either way (both PRNGs
  produce unique outputs on tight collision counts).
  Surgical proof of the entropy-source switch.
- `pnpm lint`: 0 errors / 0 warnings.
- `pnpm guard:core`: clean.
- Byte-hygiene scan: clean.
- No LLM request/response wire path touched (this is a
  CSRF state token for the Google OAuth handshake — the
  Google OAuth API is an HTTP request, not an LLM round-
  trip). `smoke:live` doesn't apply.

## Status

Done. `muse setup calendar`'s Google OAuth loopback flow
no longer derives its CSRF state from a predictable PRNG:

| Threat                                                   | Pre-fix          | Post-fix              |
| -------------------------------------------------------- | ---------------- | --------------------- |
| Casual same-user process predicts state                  | **possible**     | **infeasible** (fixed) |
| State leaks via shared-host channel (process listing)    | exposes 52 bits  | exposes 128 bits      |
| State entropy strength                                    | ~52 bits base36 | 128 bits hex          |
| Helper unit-tested                                       | no               | yes (2 tests)         |

## Decisions

- **`randomBytes(16)` → 32-char hex**, not `randomBytes(8)`.
  16 bytes is the standard OAuth-state size in production
  libraries (`oauth2orize`, `passport-oauth2`). The cost is
  negligible; the entropy headroom is worth the extra 16
  chars on the URL.
- **`.toString("hex")`, not base64url**. Hex is URL-safe by
  construction (no padding, no `+`/`/`); base64url would
  save a few characters but introduces a charset mapping
  the eye has to parse. Operators reading the OAuth URL
  in debug logs benefit from the unambiguous hex shape.
- **Extracted helper, not inlined**. The helper is
  exported solely for direct unit-test coverage — the
  surrounding `runOAuthCallbackServer` uses Clack prompts +
  real `createServer`, so a clean test seam over the
  whole function is impractical. The helper has one clear
  contract (returns 32-char hex); pinning it directly is
  the narrowest useful test.
- **Did NOT change the other `Math.random` callsites** in
  this iter:
  - `packages/agent-core/src/followup-capture-hook.ts:201`
    — follow-up ID; not security-critical (no auth check
    keys off it). Cosmetic-only; sibling-fixable later.
  - `apps/cli/src/commands-approval.ts:99` — approval
    request ID; same posture.
  - `packages/observability/src/observability-tracers.ts:84`
    — span ID; trace IDs are not security tokens.
  - `packages/resilience/src/index.ts:481` — circuit-
    breaker jitter; not security-relevant.
  Defect-class rotation logic: each `Math.random`
  callsite has different security weight. The OAuth state
  is the only one with a clear unguessable-required
  contract. Doing all four in one iter would mix
  security-critical + cosmetic changes; future iters can
  hit each on its own merits.
- **Mutation choice**. Reverted only the helper body. Hex
  test fails (base36 ≠ hex pattern); distinct-values test
  passes regardless. Surgical proof.

## Remaining risks

- **PKCE missing**. Google's OAuth-installed-app flow
  recommends PKCE (Proof Key for Code Exchange, RFC 7636)
  on top of the state nonce. Adding a PKCE
  `code_challenge`+`code_verifier` pair would close
  another attack class (an attacker who intercepts the
  authorization code can't redeem it without the
  verifier). Out of scope for this iter; future
  hardening.
- **OAuth callback path is unauthenticated**. Anyone on
  loopback can POST a fake code, the state check is the
  only gate. With 128-bit entropy that's now
  computationally infeasible to brute-force, but a
  layered defense (e.g., short timeout window on the
  callback server) would tighten further.
- **Token storage is encrypted** (`credentials.json` is
  AES-256-GCM in the credential-store pattern), but the
  Google OAuth token itself ends up there. Compromise of
  the credential-key (env var or per-host fallback) makes
  the OAuth flow's hardening moot. The credential-key
  defense is the layer below this one; goal 638 pinned
  the password-hash length to close the lenient-base64
  bypass.
- **No `state` lifetime expiry**. The callback server
  closes on the first request or on `runOAuthCallbackServer`
  rejection. A stale state token can't be replayed
  cross-process because the server dies with the CLI
  invocation. Bounded by process lifetime, which is fine.
