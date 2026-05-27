# 659 — `muse.fetch` loopback MCP server pins `redirect: "error"` on the fetch init so a 302 Location to a non-allowlisted host can't bypass the per-host allowlist via the runtime's default auto-follow behavior

## Why

`packages/mcp/src/loopback-fetch.ts:fetchWithOptionalBody`
delegated to `fetchImpl(url, { ...init, signal })` without
specifying a `redirect` mode. Node's `fetch` (undici)
defaults to `redirect: "follow"` — up to 20 hops, no
re-check of the allowlist on intermediate hosts.

**SSRF path** through the allowlist:

1. Operator allows `api.example.com` for the agent.
2. Agent calls `muse.fetch.get` with
   `https://api.example.com/something`.
3. `checkAllowed` approves the request — host matches the
   allowlist.
4. The server (compromised, misconfigured, or hostile)
   returns `302 Location: http://10.0.0.1:8080/admin/users`.
5. With auto-follow, undici opens a connection to the
   internal IP, downloads the admin response, returns it
   to the agent.
6. The agent surfaces the body via its conversation /
   tool-output channels — data exfiltration via the
   allowlisted public endpoint.

Variants the same path enables:

- **HTTPS → HTTP downgrade** to capture cleartext on a
  shared LAN.
- **Cross-origin to a metadata service** (e.g.,
  `169.254.169.254` AWS / GCP / Azure metadata) when
  Muse runs on a cloud VM.
- **Local file disclosure** via `Location: file://` —
  undici DOES NOT follow `file://` redirects, but the
  defense should not rely on that.
- **Reuse of the operator's loopback bind** —
  `Location: http://127.0.0.1:PORT/internal` against a
  service on the same machine.

The fix is one line: pass `redirect: "error"` so undici
throws a TypeError on any 3xx with a Location header.
Operators who legitimately need a redirect chain must
allowlist each hop explicitly — the safer-by-default
posture.

Trade-off considered: `redirect: "manual"` returns an
opaqueredirect (status=0, no body, no headers) which
gives the agent zero visibility into what happened.
`redirect: "error"` throws a TypeError with the redirect
URL surfaced via the existing
`catch (error) { return { error: ...message } }` block —
clearer signal.

### Defect class

**HTTP redirect following without allowlist re-check
(SSRF amplifier)** — first hit. Fresh against the
recent 10-iter window:

- 658: sort comparator tiebreaker
- 657: secret patterns ext (PGP)
- 656: secret patterns ext (PEM)
- 655: path-traversal alt-separator
- 654: PKCE feature
- 653: recursion depth bound
- 652: error msg control-char sanitization
- 651: non-crypto RNG for security token
- 650: LLM timestamp sanity bound
- 649: unbounded HTTP body

No prior iter touched redirect policy. Distinct from
649 (body byte cap), 648 (time bound), 655 (path
traversal).

## Slice

- `packages/mcp/src/loopback-fetch.ts`:
  - Added `redirect: "error"` to the spread that
    constructs the fetch init in `fetchWithOptionalBody`.
  - Updated the `get` tool description to document the
    no-auto-follow posture: "Redirects are NOT followed
    — a 3xx Location to a different host would otherwise
    bypass the allowlist; allowlist each hop explicitly
    if you need a redirect chain."
- `packages/mcp/test/mcp.test.ts`:
  - **Two new tests** in the existing `muse.fetch
    loopback server` describe:
    1. **Pin the contract**: capture the init passed to
       the underlying fetch impl, assert `init.redirect
       === "error"`. Mutation point for the fix.
    2. **End-to-end error surface**: a fake fetch that
       throws `TypeError("unexpected redirect")` (the
       shape undici produces on `redirect: "error"`
       hitting a 3xx) → tool returns `{ error: "fetch
       failed: unexpected redirect" }` via the existing
       catch path. Pins that the agent sees a clear
       error, not a silent fall-through.

## Verify

- `pnpm --filter @muse/mcp test`: 543 passed (541 prior
  + 2 new). `pnpm check` full: every workspace green;
  tsc strict EXIT=0.
- **Clean-mutation-proven**: removing the `redirect:
  "error"` from the init spread makes EXACTLY the
  "passes redirect=error" test fail with the exact
  symptom (`capturedInit.redirect` is undefined when
  the option is dropped). The error-surface test
  passes either way (the thrown-error catch is
  unrelated to the redirect setting). Restored; all
  green.
- `pnpm lint`: 0 errors / 0 warnings.
- `pnpm guard:core`: clean.
- Byte-hygiene scan on the two touched files: clean.
- No LLM request/response wire path touched. The
  loopback-fetch MCP server is the HTTP-fetch surface
  for the agent's `muse.fetch` tool, not the model
  chat path. `smoke:live` doesn't apply.

## Status

Done. The `muse.fetch` MCP server no longer auto-follows
redirects:

| Server response                                                   | Pre-fix                              | Post-fix                              |
| ----------------------------------------------------------------- | ------------------------------------ | ------------------------------------- |
| `200 OK` with body                                                | OK                                   | unchanged                             |
| `302 Location: https://api.example.test/v2/x` (same host)         | follows; returns final body          | **`{ error: "unexpected redirect" }`** |
| `302 Location: http://10.0.0.1:8080/admin`                        | **follows; SSRF data exfil**         | **`{ error: "unexpected redirect" }`** |
| `301 Location: http://api.example.test` (HTTPS → HTTP downgrade)  | **follows; cleartext**               | **`{ error: ... }`**                  |
| `302 Location: http://169.254.169.254/metadata`                   | **follows; cloud-metadata theft**    | **`{ error: ... }`**                  |
| 30 hop chain ending at an allowed host                            | follows                              | breaks at first hop (operator must allowlist each) |

## Decisions

- **`redirect: "error"`, not `"manual"`**. `"manual"`
  returns an opaqueredirect response (status=0, empty
  body, empty headers) — the agent has zero visibility
  into what happened. `"error"` throws a TypeError with
  the redirect target in the message; the existing
  `catch (error) => { return { error: ... } }` surfaces
  this cleanly. Easier for the agent to diagnose and
  decide whether to re-request through the allowlist.
- **Default `redirect: "follow"` is unsafe for an
  allowlist-gated fetcher**. The whole point of
  `allowedHosts` is to bound where the agent can talk;
  auto-follow defeats the bound. The runtime contract
  comment block already calls this out as "operator
  trusts the host enough to allow it, but that's
  partial trust" — full trust including arbitrary
  redirect targets goes well past that.
- **Updated tool description** so the agent (and the
  operator reading the MCP server inventory) sees the
  posture explicitly. "Redirects are NOT followed —
  allowlist each hop explicitly if you need a redirect
  chain." Future-proofs against the agent or operator
  assuming the default.
- **No allowlist re-check on `response.url`**. With
  `redirect: "error"` undici throws before the redirect
  target is reached — no connection to the redirect
  host. Re-check on `response.url` would be a fallback
  defense if some future code change switched back to
  `"follow"`, but layering both adds noise without
  meaningful safety with the error-throws approach.
- **Did NOT touch other fetch sites** in this iter:
  - `apps/cli/src/commands-feeds.ts:loadFeedBody` —
    RSS feeds legitimately redirect (Atom→RSS migration,
    HTTPS upgrade). Different threat model — no
    allowlist there.
  - `apps/cli/src/commands-vision.ts` — image fetch,
    same.
  - `packages/voice/src/openai-tts.ts` — OpenAI's
    canonical URLs don't redirect; if they did, the
    operator would notice.
  Each is its own iter if the threat model warrants it.
  Only the allowlist-gated `muse.fetch` is in scope
  here — the allowlist IS the redirect-defeating
  invariant.
- **Mutation choice**. Reverted only the `redirect:
  "error"` token. The "passes redirect=error" test
  fails with the exact symptom (init.redirect is
  undefined). The 11 other muse.fetch tests pass
  either way — they don't exercise the redirect
  setting. Surgical proof.

## Remaining risks

- **DNS rebinding** between `checkAllowed` and the
  actual fetch. `checkAllowed` validates the URL's
  hostname; undici then resolves the hostname at
  connect time. An attacker controlling DNS for
  `api.example.com` could return the public IP for
  the validation lookup and an internal IP at fetch
  time. Defense would require pinning the resolved IP
  between checks — out of scope.
- **CONNECT-method side channels** through HTTPS
  tunneling. Out of scope; the agent never sends
  CONNECT explicitly.
- **30x → application logic redirect** where the API
  returns 200 with a body containing
  `<meta http-equiv="refresh">` or a JS redirect.
  These aren't HTTP redirects; they're rendered by a
  browser, not by undici. Out of scope.
- **WebSocket / Server-Sent Events upgrades** with
  redirect during the handshake. The current
  `muse.fetch` is GET/HEAD only; no upgrade paths.
- **`allowedHosts` empty case**. `loopback-fetch`
  rejects requests when the allowlist is empty (the
  `has(...)` check returns false). Not affected by
  this change.
- **No telemetry on rejected redirects**. A future
  iter could log a counter so operators can see how
  often this defense fires.
