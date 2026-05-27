# 657 — `redactSecretsInText` private-key pattern now also covers PGP/GnuPG-armored private key BLOCKs (`-----BEGIN PGP PRIVATE KEY BLOCK-----`) so an accidentally-pasted GPG key from `gpg --armor --export-secret-keys` doesn't round-trip through delivery surfaces — closes the explicit gap goal 656's remaining-risks called out

## Why

Goal 656 added the `private-key` pattern to
`SECRET_PATTERNS` and noted in its Remaining Risks:

> `-----BEGIN PGP PRIVATE KEY BLOCK-----` (note "BLOCK"
> suffix, not "KEY-----") is NOT matched by this pattern.
> PGP private keys are a separate armor shape. Future iter
> could add a `(?:KEY|KEY BLOCK)` alternation to handle it.

This iter closes that gap. The PGP armor shape comes from
GnuPG's `gpg --armor --export-secret-keys` (or
`gpg --export-secret-keys | base64`-wrapped). It's the
most common way personal GPG private keys end up pasted
into notes / chat / tool outputs:

- The user runs `gpg --armor --export-secret-keys ME` to
  back up their key, copies the output, accidentally
  pastes into a Muse note instead of a secure backup.
- A tool that reads a `~/.gnupg/secring.gpg` or similar
  surfaces the armored body in its output.
- An imported email contains a PGP-encrypted attachment
  block in its body.

Without redaction, the entire armored key reaches Slack /
Discord / Telegram / chat-history verbatim — same exposure
class as the RSA / EC / OPENSSH keys goal 656 closed.

The fix: extend the existing regex with an optional
` BLOCK` suffix on both BEGIN and END markers:

```ts
/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY(?: BLOCK)?-----/gu
```

One regex covers both the X.509/OpenSSH family (RSA / DSA
/ EC / OPENSSH / bare PKCS#8 / ENCRYPTED) AND the PGP
BLOCK shape.

### Defect class

**Extending the SECRET_PATTERNS catalog** — sibling to
656. Within the 10-iter window:

- 656: PEM private-key (RSA/DSA/EC/OPENSSH/bare)
- 655: path-traversal alt-separator
- 654: PKCE (defense-in-depth)
- 653: recursion depth bound
- 652: error msg control-char sanitization
- 651: non-crypto RNG for security token
- 650: LLM timestamp sanity bound
- 649: unbounded HTTP body
- 648: HTTP fetch timeout
- 647: bracket parser inString

2 of 10 in the SECRET_PATTERNS-extension class
(656 + 657) — under the 3-in-10 redirect threshold. The
follow-up is the explicit closure of a noted gap, not a
"keep extending the same thing" drift.

## Slice

- `packages/shared/src/index.ts`:
  - One-token change to the existing `private-key`
    regex: insert `(?: BLOCK)?` after `PRIVATE KEY` in
    both the BEGIN and END branches.
  - Updated the trailing comment to mention "PGP
    `...PRIVATE KEY BLOCK...`".
- `packages/shared/test/shared.test.ts`:
  - **One new `it()` block** with 3 assertions:
    1. PGP private-key block (multi-line, with `Version:`
       header + base64 body + `=Az9X` checksum) →
       `[redacted-private-key]`.
    2. PGP key surrounded by mail-style prose →
       redacted as one unit, prose preserved.
    3. PGP PUBLIC KEY BLOCK is NOT redacted (public; no
       sensitive material) — pin the negative case.

## Verify

- `pnpm --filter @muse/shared test`: 30 passed (29 prior
  + 1 new it block, 3 new expects). Full `pnpm check`:
  every workspace green; tsc strict EXIT=0.
- **Clean-mutation-proven**: reverting the
  `(?: BLOCK)?` extension makes EXACTLY the new PGP test
  fail with the exact symptom (the PGP-BLOCK frame
  passes through unredacted). The 9 pre-existing
  private-key tests from 656 (RSA / OPENSSH / EC / bare
  PKCS#8 / precedence / PUBLIC KEY / plain prose) pass
  either way. Restored; all green.
- `pnpm lint`: 0 errors / 0 warnings.
- `pnpm guard:core`: clean.
- Byte-hygiene scan on the two touched files: clean.
- Scrubber runs on already-resolved text, no LLM wire
  path touched. `smoke:live` doesn't apply.

## Status

Done. PGP/GnuPG private-key blocks are now redacted
alongside the X.509/OpenSSH family:

| Key shape                                  | Pre-fix              | Post-fix              |
| ------------------------------------------ | -------------------- | --------------------- |
| RSA / DSA / EC / OPENSSH / bare PKCS#8     | redacted (goal 656)  | unchanged             |
| `-----BEGIN PGP PRIVATE KEY BLOCK-----`    | **passes intact**    | `[redacted-private-key]` (fixed) |
| `-----BEGIN PGP PUBLIC KEY BLOCK-----`     | passes intact        | passes intact (correct — public) |
| Plain English "private key"                | passes intact        | passes intact (no false positive) |

## Decisions

- **Single regex with optional ` BLOCK` suffix**, not a
  second `SECRET_PATTERN` entry. One pattern with
  `(?: BLOCK)?` covers both armor shapes with a single
  pass; two patterns would double the scan cost
  per-string. Mismatched BEGIN/END (e.g.,
  `BEGIN PRIVATE KEY` paired with `END PRIVATE KEY
  BLOCK`) would technically match — that's a
  malformed key but redacting it is conservatively
  correct.
- **The `(?:[A-Z]+ )?` alg prefix also applies to PGP
  BLOCKs in principle**. Real PGP frames never carry an
  algorithm prefix (the shape is always
  `-----BEGIN PGP PRIVATE KEY BLOCK-----`), but the
  regex tolerates one if a malformed dump produces it.
  Cost: zero false positives observed across the test
  suite.
- **PUBLIC KEY BLOCK negative test pinned**. PGP's
  `-----BEGIN PGP PUBLIC KEY BLOCK-----` shape is
  legitimate non-sensitive material (it's the public
  half of the keypair). The `PRIVATE` literal anchor
  in the regex prevents the match — same defense the
  X.509 family used.
- **Catastrophic-backtrack still safe**. The added
  `(?: BLOCK)?` is bounded (matches the literal
  string ` BLOCK` or nothing); no nested quantifiers.
- **Mutation choice**. Reverted only the
  `(?: BLOCK)?` extension. The new test fails with
  the exact "PGP frame survives intact" symptom; the
  9 pre-existing private-key tests from goal 656 pass
  regardless. Surgical proof.

## Remaining risks

- **Truncated PGP blocks** (no END marker) still slip
  past the lazy `[\s\S]*?`. Real-world truncated keys
  are useless, so this isn't a leak — just a missed
  redact on garbage input.
- **Other secret families still missing**: HuggingFace
  tokens (`hf_...`), Notion integration tokens
  (`secret_...`), Linear API keys (`lin_api_...`),
  Hashicorp Vault tokens, OpenAI session tokens
  (`sk-...` is covered but session cookies aren't).
  Sibling-fixable in future iters.
- **Binary-encoded keys** (raw `.gpg` / `.pgp` /
  `.kbx` bytes, not ASCII-armored) won't match. The
  scrubber is text-pattern only. Out of scope.
- **In-line embedded keys** (the body of an email
  attachment encoded inside a JSON string with
  escaped newlines `\\n`) would survive intact —
  JSON-escape unwrapping isn't part of the scrubber's
  contract. Could be added but increases false-
  positive surface significantly.
