# 654 — `muse setup calendar` Google OAuth loopback flow now adds **PKCE (RFC 7636)** on top of the goal-651 state nonce, so an attacker who intercepts the authorization code (via a same-host process logging the redirect, a shared-terminal scrollback, an old crash dump) still can't redeem it for tokens without also possessing the per-flow `code_verifier` the CLI keeps in-memory

## Why

Goal 651 closed the predictable-state attack class by switching
the OAuth CSRF state token to `crypto.randomBytes(16)`. That
protects against an attacker who can REPLAY a stolen `state` —
but it doesn't help against an attacker who intercepts the
**authorization code** itself:

1. **Same-host process** with permission to read a sibling
   user's process listing (rare but possible with `ps aux`-
   level OS configurations).
2. **Shell history / scrollback** capturing the redirect URL.
3. **HTTP intermediate** (the redirect goes to
   `http://127.0.0.1:<port>/callback?code=AUTH_CODE&state=...`
   over the loopback interface; in a multi-user box where a
   capable attacker can sniff loopback packets via `lsof`-style
   privilege).
4. **Crashed CLI** leaving the auth code in core/heap dumps.

With just the authorization code, an attacker can POST to
Google's token endpoint with the legit `client_id + client_secret`
(which they might also have if they share the OAuth app, common
in personal projects) and redeem `refresh_token` + `access_token`.

**RFC 7636 PKCE** (Proof Key for Code Exchange) closes this
class:

1. CLI generates a random `code_verifier` (32 bytes →
   base64url-encoded 43 chars).
2. CLI computes `code_challenge = base64url(SHA-256(verifier))`.
3. CLI sends `code_challenge` + `code_challenge_method=S256`
   in the authorization request.
4. Google's authorization server stores the challenge with
   the issued code.
5. After redirect, the CLI sends `code_verifier` (the
   pre-image of the challenge) with the token-exchange POST.
6. Google verifies `SHA-256(verifier) === stored_challenge`
   before issuing tokens.

The verifier never leaves the CLI process; only its SHA-256
hash hits the network. An attacker with the auth code alone
can't compute the verifier (SHA-256 is one-way), so the token
exchange fails.

Google supports PKCE for native/installed apps and recommends
it. Adding it is purely defense-in-depth — no usability cost,
no flow change visible to the user.

### Defect class

**Defense-in-depth feature — OAuth installed-app flow without
PKCE**. Sibling to goal 651's state-nonce hardening but a
distinct mechanism (binds the code to the requesting client,
not just preventing state replay). Fresh against the recent
10-iter window:

- 653: recursion depth bound
- 652: error msg control-char sanitization
- 651: non-crypto RNG for security token (state nonce)
- 650: LLM timestamp sanity bound
- 649: unbounded HTTP body
- 648: HTTP fetch timeout
- 647: bracket parser inString
- 646: FIFO cap
- 645: file mode 0o600
- 644: finite-guard

None previously added PKCE or a similar pre-image-binding
mechanism for OAuth.

## Slice

- `apps/cli/src/setup-calendar.ts`:
  - Added `createHash` to the existing `node:crypto` import.
  - **New exported helper** `generatePkcePair(): PkcePair`:
    - `verifier`: `randomBytes(32).toString("base64url")` →
      43 chars (RFC 7636's lower bound).
    - `challenge`:
      `createHash("sha256").update(verifier).digest("base64url")`.
    - `method`: `"S256"` (the secure-hash method; never
      `"plain"`).
  - **`OAuthCallbackOptions`** extended with an optional
    `pkce?: PkcePair`. When set, the auth URL includes
    `code_challenge` + `code_challenge_method` query params.
  - **`setupGoogle`** now:
    - Calls `generatePkcePair()` before the auth flow.
    - Passes `pkce` through to `runOAuthCallbackServer` so
      the challenge lands in the authorization URL.
    - Includes `code_verifier: pkce.verifier` in the
      token-exchange POST body.
- `apps/cli/src/setup-calendar.test.ts`:
  - Import updated.
  - **Four new tests** for `generatePkcePair`:
    1. **43-char base64url verifier** — pins RFC 7636 lower
       bound (`^[A-Za-z0-9_-]{43}$`).
    2. **Challenge = SHA-256(verifier) base64url-encoded** —
       pre-image-bound by hash. This is the test that fails
       under mutation when the challenge is set to the
       verifier itself (the "plain" method).
    3. **Method = "S256"** — pin the secure method; `"plain"`
       would defeat PKCE (an attacker who steals the
       challenge could derive the verifier directly).
    4. **Distinct values across 50 samples** — pins
       `randomBytes` uniqueness for both verifier and
       challenge.

## Verify

- `pnpm --filter @muse/cli test`: 1123 passed isolated (1119
  prior + 4 new). Full `pnpm check`: 1127 passed
  cross-package; apps/api 270/270, every workspace green;
  tsc strict EXIT=0.
- **Clean-mutation-proven**: changing the helper body from
  `challenge = createHash("sha256").update(verifier).digest("base64url")`
  to `challenge = verifier` (the "plain" non-S256 mode) makes
  EXACTLY the SHA-256-equality test fail with the exact
  symptom — `pair.challenge` is the raw verifier, not the
  expected hash. The 3 other tests (43-char shape, method =
  "S256", uniqueness) pass either way because they don't
  depend on the hash binding. Restored; all green.
- `pnpm lint`: 0 errors / 0 warnings.
- `pnpm guard:core`: clean.
- Byte-hygiene scan on the two touched files: clean.
- No LLM request/response wire path touched. Google's OAuth
  HTTP handshake isn't an LLM round-trip. `smoke:live` doesn't
  apply.

## Status

Done. `muse setup calendar`'s Google OAuth loopback flow now
has both state nonce (goal 651) and PKCE (goal 654):

| Attack vector                                          | Before goal 651        | After 651, before 654   | After goal 654              |
| ------------------------------------------------------ | ---------------------- | ----------------------- | --------------------------- |
| Predictable state nonce (Math.random)                   | **exploitable**        | fixed                   | unchanged                   |
| Authorization code intercepted via same-host process    | **exploitable**        | exploitable             | **mitigated (PKCE binds)**  |
| Authorization code in shell scrollback                  | exploitable            | exploitable             | mitigated                   |
| Authorization code in crash dump / heap snapshot        | exploitable            | exploitable             | mitigated (verifier in-mem) |
| Replayed state nonce                                    | exploitable             | mitigated               | mitigated                   |

## Decisions

- **`randomBytes(32)` → 43-char base64url verifier**, the RFC
  7636 minimum-recommended length. The upper bound is 128
  chars; 43 is plenty of entropy (256 bits encoded) without
  bloating the URL. Matches `oauth2orize`, `google-auth-
  library`, `simple-oauth2` defaults.
- **SHA-256 / "S256" method only**. RFC 7636 also allows
  `"plain"` (challenge = verifier), but that defeats the
  whole mechanism — an attacker with the challenge directly
  has the verifier. `"S256"` is the only safe choice;
  pinned in the unit test.
- **`base64url`, not `base64`**. RFC 4648 §5 base64url is URL-
  safe (no `+`/`/`/padding). The challenge lands in a query
  string; standard base64's `+` would be URL-encoded to
  `%2B`, the `=` padding likewise; using base64url avoids the
  encoding overhead.
- **`pkce` optional on `OAuthCallbackOptions`**. Backward
  compatible for any future callsite that doesn't want PKCE
  (e.g., a service that doesn't support it). Google does
  support PKCE on its installed-app flow, so the call from
  `setupGoogle` always passes the pair.
- **Verifier kept in-memory only**. Never persisted, never
  logged. The CLI process holds it from generation to
  token exchange, then it's GC'd. Compromising heap dumps
  is the only way to extract it, and at that point you have
  the access token already.
- **No PKCE for CalDAV / macOS / Local**. They're not OAuth
  flows. Per-provider — only Google needs this.
- **Mutation choice**. Reverted only the hash computation
  (`createHash(...).update(...).digest(...)` → bare
  `verifier`). The SHA-256-equality test fails with the
  exact symptom; the 3 structural tests pass regardless.
  Surgical proof.

## Remaining risks

- **`client_secret` still flows in the token-exchange body**.
  Google's installed-app OAuth client conventionally has a
  client_secret, but RFC 7636 §1.2 notes that PKCE was
  designed for **public clients without secrets**. Google's
  position: native apps can have a secret but it's not
  trustworthy; PKCE is the real defense. So sending both
  matches Google's documented flow. Future iter could
  remove the secret in favor of PKCE-only flow if Google
  supports it (they do for the OAuth 2.0 Web Server flow).
- **Authorization Code interception is mitigated, not
  eliminated**. PKCE binds the code to a request the
  attacker can't replay, but if the attacker controls the
  CLI process AT THE MOMENT of the token exchange, they
  can extract both code and verifier from memory. That
  threat model is "attacker has full code execution as
  the user" which is unfightable at this layer.
- **No PKCE on token refresh**. The refresh token, once
  issued, can be redeemed at any time without PKCE. Google's
  refresh-token design is to scope this via the
  `client_secret` + a server-side revocation list.
  Out-of-scope for this iter.
- **The `pkce` plumbing is a CLI-only path right now**. If
  Muse later adds a server-side OAuth flow (web UI does
  Google sign-in), that path needs its own PKCE wiring.
  Sibling-applicable when that flow lands.
