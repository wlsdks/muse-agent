# 656 — `redactSecretsInText` (the shared secret-shape scrubber) gains a PEM-encoded private-key pattern (RSA / DSA / EC / OPENSSH / bare) so a key accidentally pasted into a note, tool output, or chat message can't round-trip through `proactive-history` / Slack / Discord / Telegram / the chat-history log

## Why

`packages/shared/src/index.ts:redactSecretsInText` catches
high-confidence credential shapes and replaces them with
`[redacted-<family>]`. The pre-fix pattern list covered:

- API keys (OpenAI, Anthropic, GitHub, Google, Slack, Stripe,
  GitLab)
- JWTs
- Connection URIs with inline passwords
- AWS access keys
- Telegram / Discord bot tokens

But **PEM-encoded private keys** — the most catastrophic
credential class in any developer's environment — were
missing. A leaked private key is unrotatable on the spot and
grants full account / server access wherever it's enrolled.

Realistic exposure paths:

1. **Notes RAG**: `muse notes save` of a note that pasted
   the contents of `~/.ssh/id_ed25519`. Later `muse ask`
   surfaces the note in a RAG hit; the LLM's grounded answer
   echoes the key body verbatim. Without redaction, the key
   reaches the user's terminal — and any downstream channel
   if the proactive daemon picks it up.

2. **Tool output**: a tool like `read_file` is asked to read
   `~/.ssh/id_rsa`. The output threads through the
   conversation, gets summarised, gets archived to
   chat-history.

3. **Proactive notice**: a task title "rotate this key:
   `-----BEGIN RSA PRIVATE KEY-----...`" — entire ASCII-
   armored block becomes a Telegram push.

4. **Watch-folder ingestion**: an external drop-zone file
   that happens to be a PEM-formatted key.

All these paths funnel through `redactSecretsInText` (or
should). Pre-fix the key was left untouched.

### Defect class

**Missing high-impact secret pattern in the redaction list**.
First hit for the "extend the SECRET_PATTERNS catalog"
direction; sibling to goal 086's introduction of the
scrubber, but adding a new pattern. Fresh against the recent
10-iter window:

- 655: path-traversal alt-separator
- 654: PKCE (defense-in-depth)
- 653: recursion depth bound
- 652: error msg control-char sanitization
- 651: non-crypto RNG for security token
- 650: LLM timestamp sanity bound
- 649: unbounded HTTP body
- 648: HTTP fetch timeout
- 647: bracket parser inString
- 646: FIFO cap

No prior iter extended `SECRET_PATTERNS`. Distinct from 651
(CSRF nonce hardening) and 652 (terminal-char sanitization).

## Slice

- `packages/shared/src/index.ts`:
  - **New first entry in `SECRET_PATTERNS`**:
    ```ts
    { name: "private-key",
      regex: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/gu }
    ```
    The `(?:[A-Z]+ )?` optionally matches the algorithm
    prefix (`RSA `, `DSA `, `EC `, `OPENSSH `, `ENCRYPTED `,
    or bare). The `[\s\S]*?` lazy match grabs the base64
    body without crossing into another PEM block.
  - Placed **first** in the list — same precedence trick
    the connection-URI rule uses. Ensures the entire frame
    is redacted as one unit before a sub-pattern (jwt /
    openai-key / etc.) can nibble the base64 body.
- `packages/shared/test/shared.test.ts`:
  - **One new `it()` block** with 8 assertions:
    1. RSA private key inside surrounding prose → exact
       replacement with `[redacted-private-key]`.
    2. OPENSSH PRIVATE KEY (ed25519 / common SSH key shape).
    3. EC PRIVATE KEY (Elliptic Curve, used by many modern
       SSH and TLS configs).
    4. Bare `PRIVATE KEY` (PKCS#8, no algorithm prefix).
    5. Two keys in one input → both redacted, text between
       them preserved.
    6. **Precedence test**: a PEM whose body LOOKS like a
       JWT (`eyJ...`) gets redacted as one `[redacted-
       private-key]`, not nibbled by the jwt pattern.
    7. **No false positive on plain English** ("the user's
       private key is on their laptop").
    8. **No false positive on a PUBLIC KEY PEM** (different
       marker; contains no sensitive material).

## Verify

- `pnpm --filter @muse/shared test`: 29 passed (28 prior +
  1 new it block, 8 new expect assertions). Full `pnpm
  check`: every workspace green; tsc strict EXIT=0.
- **Clean-mutation-proven**: removing the new
  `{ name: "private-key", ... }` entry makes EXACTLY the new
  PEM-redaction expects fail with the exact symptom — the
  PEM frame survives the scrubber unmodified, the prelude
  and trailing text print fine but the redaction never
  fires. The 8 pre-existing redaction tests (OpenAI, GitHub,
  JWT, etc.) and the no-false-positive tests pass either
  way. Restored; all green.
- `pnpm lint`: 0 errors / 0 warnings.
- `pnpm guard:core`: clean.
- Byte-hygiene scan on the two touched files: clean.
- No LLM request/response wire path touched. The scrubber
  runs on already-resolved string output. `smoke:live`
  doesn't apply.

## Status

Done. A PEM-format private key in any text that flows through
`redactSecretsInText` is now scrubbed before it reaches any
delivery surface:

| Key shape                          | Pre-fix             | Post-fix                  |
| ---------------------------------- | ------------------- | ------------------------- |
| `-----BEGIN RSA PRIVATE KEY-----`  | **passes intact**   | `[redacted-private-key]` |
| `-----BEGIN OPENSSH PRIVATE KEY-----` | **passes intact**| `[redacted-private-key]` |
| `-----BEGIN EC PRIVATE KEY-----`   | **passes intact**   | `[redacted-private-key]` |
| `-----BEGIN PRIVATE KEY-----` (PKCS#8) | **passes intact** | `[redacted-private-key]` |
| `-----BEGIN PUBLIC KEY-----`       | passes intact       | passes intact (correct — not sensitive) |
| Plain English "private key"        | passes intact       | passes intact (no false positive) |

## Decisions

- **Pattern bounded by BEGIN..END markers**, not by
  base64 charset. A noisy body (whitespace variants, PGP
  comment headers, encrypted-PEM ":" headers) all survive
  the `[\s\S]*?` lazy match. The marker pair is the
  unambiguous signal that this is a key.
- **`(?:[A-Z]+ )?` optional algorithm prefix**. Covers
  every PEM private-key variant I'm aware of (RSA, DSA,
  EC, OPENSSH, ENCRYPTED, bare PKCS#8). The trailing space
  is required when the prefix is present (`RSA PRIVATE`
  vs `PRIVATE`). The `[A-Z]+` is bounded by the literal
  `PRIVATE` that follows, so no catastrophic backtracking.
- **Lazy `[\s\S]*?` for the body**. Greedy would cross
  into the next PEM block if two keys appear in one
  input. Lazy stops at the first `-----END ... PRIVATE
  KEY-----` marker. Test 5 (two keys) pins this.
- **First in pattern list, not last**. Same precedence
  trick the existing connection-URI rule uses. A PEM body
  contains base64 chars that can shape-match JWT or
  openai-key patterns — running the PEM rule first redacts
  the whole frame as `[redacted-private-key]`, then the
  sub-patterns find nothing.
- **PUBLIC KEY is NOT redacted**. Public keys are meant to
  be public; redacting them would be incorrect. The
  `BEGIN PRIVATE` literal anchor prevents that match.
- **"private key" in plain prose is NOT redacted**. The
  `-----BEGIN ... -----` marker is the signal. A sentence
  like "the user's private key is on their laptop" doesn't
  match — pinned in test 7.
- **ENCRYPTED PRIVATE KEY** (PKCS#8 password-protected) is
  also caught — the body is still high-confidence
  sensitive material even if encrypted at rest. The
  `(?:[A-Z]+ )?` prefix handles the `ENCRYPTED ` variant.
- **Mutation choice**. Removed the new pattern entry
  entirely. The new test fails with the exact "PEM frame
  survives intact" symptom; all 8 pre-existing
  redaction-and-no-false-positive tests pass regardless.
  Surgical proof.

## Remaining risks

- **`-----BEGIN CERTIFICATE-----`** (X.509 cert) is NOT
  redacted. Certificates are public; their bodies don't
  contain key material. Correct posture.
- **Other PEM-armored secrets**: `-----BEGIN PGP PRIVATE
  KEY BLOCK-----` (note "BLOCK" suffix, not "KEY-----")
  is NOT matched by this pattern. PGP private keys are a
  separate armor shape. Future iter could add a `(?:KEY|
  KEY BLOCK)` alternation to handle it.
- **Truncated keys** (body cut off, no END marker) survive
  the scrubber — the lazy match never closes. Real-world
  truncated keys are useless, so this isn't a security
  exposure, but a defensive bound on body length (e.g.,
  10 KB) would catch the pathological case.
- **Inline `ssh-rsa AAAAB3NzaC1yc2E...` public-key shape**
  (no PEM frame, the OpenSSH `authorized_keys` line
  format) — that's a PUBLIC key, doesn't need redaction.
- **Other secret families still missing**: HuggingFace
  tokens (`hf_...`), Notion integration tokens (`secret_
  ...`), Linear API keys (`lin_api_...`), Hashicorp Vault
  tokens. Sibling-fixable in future iters.
- **The scrubber is text-only**. A key serialised into
  binary (e.g., embedded in a file attachment or a
  base64-encoded blob without PEM framing) won't match.
  Out of scope — the function's contract is text-pattern
  matching.
