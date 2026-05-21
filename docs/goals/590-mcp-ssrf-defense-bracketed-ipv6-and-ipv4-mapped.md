# 590 — close two SSRF gaps in `isPrivateOrReservedHost` / `isPublicHttpUrl`: bracketed-IPv6 hostnames from Node's URL parser, and IPv4-mapped IPv6 in both dotted and Node-canonical hex forms

## Why

`packages/mcp/src/validators.ts:isPrivateOrReservedHost` is the SSRF
defense for remote MCP server URLs (`sse` / `streamable` transports
in `McpManager`). It rejects loopback, RFC1918, link-local, and
multicast hosts BEFORE Muse opens an HTTP connection — so a
configured MCP entry pointing at `http://127.0.0.1/admin`,
`http://169.254.169.254/latest/meta-data` (AWS metadata service),
or any other private host can't be used to exfiltrate from the
Muse process.

Two real gaps existed:

1. **Bracketed IPv6 hostname bypass.** `isPublicHttpUrl` extracts
   `url.hostname` from `new URL(value)`. For an IPv6 URL like
   `http://[::1]/`, Node's `URL.hostname` keeps the brackets —
   it returns the literal string `[::1]`. The downstream
   `net.isIP("[::1]")` returns `0` (= invalid, brackets not
   accepted), so the function fell through to the early
   `return false` at the `ipVersion === 0` guard — meaning
   "not an IP, treat as public."

   Result: **every IPv6 URL passed the SSRF check.** A remote
   MCP entry pointing at `http://[::1]:1234/mcp` or
   `https://[fc00::dead:beef]/mcp` was treated as eligible
   for connection.

   Verified directly:

   ```
   $ node -e 'console.log(new URL("http://[::1]/").hostname)'
   [::1]
   $ node -e 'console.log(require("net").isIP("[::1]"))'
   0
   ```

2. **IPv4-mapped IPv6 bypass.** An IPv4 address can be addressed
   through the v6 stack as `::ffff:a.b.c.d`. Even with bracket-
   stripping fixed, the pre-existing v6 branch checks only
   `::1`, `fc*`, `fd*`, `fe80*` prefixes — none of which match an
   `::ffff:` form. A URL like `http://[::ffff:127.0.0.1]/` would
   slip past as "v6, no known private prefix ⇒ public."

   Worse: Node's URL parser **canonicalises** the dotted form
   to pure-hex, so the actual hostname Muse sees is even
   further from the v4-rule branch:

   ```
   $ node -e 'console.log(new URL("http://[::ffff:127.0.0.1]/").hostname)'
   [::ffff:7f00:1]
   ```

   The hex groups `7f00:1` encode the 32-bit IPv4 value
   `0x7f000001` = `127.0.0.1` (loopback). Without an explicit
   decoder, the defense missed every IPv4-mapped private host
   expressed via the v6 stack — loopback, RFC1918, the cloud-
   metadata 169.254.169.254 — all silently allowed.

Step-8 redirect: the prior commits sat in `packages/agent-core`
(589), `packages/calendar` (588), and the env-flag spelling sweep
before that. This iteration moves to `packages/mcp` (last touched
in goal 540 for an empty-env defect) and a distinct defect class:
SSRF defense / IPv6 edge-case handling on a security-critical
host classifier.

## Slice

- `packages/mcp/src/validators.ts:isPrivateOrReservedHost`:
  - Strip `[brackets]` from the hostname at the top, BEFORE
    calling `net.isIP`. One-line regex
    `host.toLowerCase().replace(/^\[(.*)\]$/u, "$1")` handles the
    URL-parser shape Node produces. Short WHY comment explains
    the SSRF bypass this closes (non-derivable from the code).
  - Add explicit `::` (unspecified address) check alongside the
    existing `::1` (loopback) check. The unspecified address is
    a binding listener, not a routable destination — treat as
    private.
  - Add IPv4-mapped IPv6 recursion: when the v6 address matches
    `^::ffff:…` in either dotted (`::ffff:a.b.c.d`) or hex
    (`::ffff:HHHH:LLLL`) form, decode the embedded IPv4 and
    re-call `isPrivateOrReservedHost` on the dotted-quad. The
    existing v4 branch then handles loopback / RFC1918 / 169.254
    / 224+ uniformly.
- `packages/mcp/src/validators.ts:decodeIpv4MappedV6` — new
  private helper. Two regexes; the hex branch decodes the high
  and low 16-bit groups into the four IPv4 octets via shift +
  mask.
- `packages/mcp/test/mcp.test.ts` — 4 new tests added at the end
  of the existing "MCP security policy" describe:
  - **Bracketed IPv6 rejection** — pins the fundamental gap
    that every IPv6 URL slipped past. Tests both `isPrivateOr
    ReservedHost("[::1]")` directly (the legacy unit surface)
    AND `isPublicHttpUrl("http://[::1]/mcp")` (the end-to-end
    URL surface).
  - **IPv4-mapped IPv6 (dotted AND hex)** — covers loopback,
    RFC1918 (10/8, 172.16/12, 192.168/16), link-local + cloud
    metadata (169.254/16), multicast (224+), unspecified
    (0.0.0.0), with a counter-test that `::ffff:8.8.8.8` stays
    public (no false-positive widening). Hex-canonical pinned
    via `::ffff:7f00:1` (= 127.0.0.1), `::ffff:a9fe:a9fe`
    (= 169.254.169.254), and the non-private `::ffff:808:808`
    (= 8.8.8.8). End-to-end via `isPublicHttpUrl` so the URL
    parser's canonicalisation is exercised.
  - **Unspecified `::`** — pins the new check.
  - **Regression for `::1` / `fc*` / `fd*` / `fe80*`** — pins
    the pre-existing v6 prefix logic, so a future refactor
    that "simplifies" the function can't silently regress
    them.

## Verify

- `@muse/mcp` suite green (531 passed, +4 vs baseline 527, 0
  failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the bracket-
  strip line back to `host.toLowerCase()` (no replace) makes 3
  of the 4 new tests fail — bracketed-IPv6, IPv4-mapped-end-to-
  end-via-URL, and unspecified-via-`[::]` — because all three
  arrive through Node's URL parser with brackets. The
  regression test for bare `::1` / `fc00::1` stays green (those
  inputs were never bracketed). Fix restored, suite back to
  all green.
- `pnpm check` EXIT=0 (apps/api 249 passed, apps/cli 1040
  passed, every workspace green); `pnpm lint` 0/0; `pnpm
  guard:core` clean; `git status` shows only the two intended
  files.
- No LLM request-response wire path touched; `smoke:live` does
  not apply (per `testing.md` / iteration-loop Step 9). The
  defended path is the MCP server-registration validator
  (`McpManager.register` calls `validateMcpServer` ⇒
  `isPublicHttpUrl` ⇒ `isPrivateOrReservedHost`), exercised
  BEFORE any HTTP connection — not the model loop.

## Status

Done. The MCP SSRF defense now covers all common IPv6
representations of private hosts:

| Host shape                              | Before                       | After                                |
| --------------------------------------- | ---------------------------- | ------------------------------------ |
| `127.0.0.1`                             | rejected (private)           | unchanged                            |
| `::1`                                   | rejected (private)           | unchanged                            |
| `[::1]` (URL-parser bracketed)          | **`isPublic` ⇒ true (SSRF)** | rejected (**fixed**)                 |
| `::`                                    | not classified ⇒ public      | rejected (**fixed**)                 |
| `[::]` (URL-parser bracketed)           | not classified ⇒ public      | rejected (**fixed**)                 |
| `::ffff:127.0.0.1` (dotted)             | not classified ⇒ public      | rejected via v4 recurse (**fixed**)  |
| `::ffff:7f00:1` (hex canonical)         | not classified ⇒ public      | rejected via v4 recurse (**fixed**)  |
| `::ffff:a9fe:a9fe` (= 169.254.169.254)  | not classified ⇒ public      | rejected via v4 recurse (**fixed**)  |
| `::ffff:8.8.8.8` (public IPv4-mapped)   | public                       | unchanged (still public)             |
| `2606:4700:4700::1111` (Cloudflare DNS) | public                       | unchanged                            |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a security
hardening `fix:` on the MCP SSRF defense — recorded honestly
with this backlog row — not a false metric.

## Decisions

- **Bracket-strip via regex anchored at both ends.** Used
  `/^\[(.*)\]$/u` rather than `slice(1, -1)` because a hostname
  that happens to contain `[` or `]` mid-string (a malformed
  input that doesn't match the anchors) is left alone. Anchored
  is safer than blind position-based stripping.
- **Decode IPv4-mapped IPv6, don't widen v6 prefix checks.**
  The naive fix would be to add `::ffff` to the v6 prefix list,
  but that would also reject *legitimate* `::ffff:*` addresses
  that happen to encode a public IPv4 (like `::ffff:8.8.8.8`).
  Decoding to the dotted form and reusing the v4 rules is the
  precise fix — only the actually-private mapped addresses are
  rejected. The counter-test for `::ffff:8.8.8.8` staying
  public pins this contract.
- **Recursive call rather than inlined logic.** The v4 branch
  is non-trivial (multiple range checks). Re-calling
  `isPrivateOrReservedHost` with the decoded IPv4 reuses the
  exact same rules, so future v4-rule changes (e.g. adding
  `100.64.0.0/10` CGNAT to the private set) automatically apply
  to mapped IPv6 too — no second site to maintain.
- **Two regex forms for IPv4-mapped IPv6.** The dotted form
  `^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$` matches raw
  user input. The hex form `^::ffff:([0-9a-f]{1,4}):([0-9a-f]
  {1,4})$` matches what Node's URL parser produces after
  canonicalisation. Both are tested.
- **`::` (unspecified address) handled.** Browsers and Node's
  fetch interpret `::` as either the wildcard / unspecified
  address or as 0.0.0.0 (which is in the v4 private set). The
  explicit check pins the rejection regardless of how a future
  Node version resolves it.

## Remaining risks

- **Link-local IPv6 prefix is fe80::/10**, which covers `fe80`–
  `febf`. The existing check is `normalized.startsWith("fe80")`
  — narrower than the spec. In practice virtually all real
  link-local addresses use the canonical `fe80::` prefix so
  this is a low-leverage gap, but a follow-up could widen to
  match `^fe[89ab]/u`. Deferred to keep scope tight.
- **Hostname → IP DNS resolution is not done.** A URL with a
  domain name like `localhost.attacker.example.com` (resolving
  to 127.0.0.1 via attacker DNS) would NOT be caught by host-
  string classification alone. The existing
  `endsWith(".localhost")` check guards the common literal
  case, but full DNS-rebinding defense requires resolving and
  re-classifying — a separate, larger design change (would
  also bring latency / async cost into a currently-sync
  function). Out of scope.
- **6to4 / Teredo / unique-local-deprecated prefixes** could
  also encode private hosts. Not seen in the wild for MCP
  servers; deferred.
