# 638 — `PasswordHasher.verify` pins the decoded `expected` Buffer to the exact scrypt output length (64 bytes) so a corrupt `passwordHash` whose base64url segment decodes to an empty Buffer can't authenticate ANY password — closes a critical bypass in the timing-equal path

## Why

`packages/auth/src/index.ts:PasswordHasher.verify` was the
single chokepoint for verifying every stored password
hash (REPL login, HTTP `/auth/login`, password-change flow).
Pre-fix:

```ts
verify(password: string, passwordHash: string): boolean {
  const [version, salt, hash] = passwordHash.split(":");
  if (version !== passwordHashVersion || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const actual = scryptSync(password, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
```

The `!hash` truthy check rejects an EMPTY hash segment
(`"scrypt-v1:salt:"`). But it does NOT reject a non-empty hash
segment that **decodes to zero bytes**. Node's `Buffer.from(_,
"base64url")` is **intentionally lenient** — per the docs:

> "Characters that are not in the Base64 alphabet are silently
> ignored."

So `Buffer.from("???", "base64url")` returns a 0-byte Buffer
(all three `?`s are dropped). Then:

1. `expected.length === 0` → `scryptSync(password, salt, 0)`
   returns a 0-byte Buffer (scrypt with a length-0 output
   request).
2. `actual.length === expected.length` → `0 === 0` → true.
3. `timingSafeEqual(empty, empty)` → **true** (two equal-length
   zero buffers compare equal).

→ `verify(<ANY password>, "scrypt-v1:salt:???")` returns
**true**. Password bypass.

### Reachability

The defect triggers when a stored `passwordHash` field has any
non-base64url chars that the decoder drops to zero. Realistic
shapes:

- **Hand-edited `~/.muse/users.json`** — a developer or
  operator accidentally truncates or types non-base64url
  chars while debugging. Auth bypass for that user.
- **Migration / schema-change bug** — a tool that re-encodes
  the hash mangles its base64url alphabet (e.g. URL-decoding a
  hash that wasn't URL-encoded turns `+` → space, `/` → `_`,
  etc.). If the result drops to length 0, bypass.
- **Botched copy-paste between admin tools** — a hash quoted
  by a CSV/spreadsheet round-trip can lose all valid chars to
  smart-quotes / em-dashes / unicode lookalikes that the
  base64url decoder silently drops.
- **Cosmic-ray-level: a 1-bit storage flip** that turns a
  valid char into an invalid one — combined with the `Buffer
  .from` leniency, a single damaged char doesn't fail
  loudly; it just drops to a shorter length.

Healthy hashes (those produced by `hashPassword`) always have
64 bytes — `scryptSync(_, _, 64).toString("base64url")` emits
a 64-byte payload. So the post-fix length-pin is consistent
with every legitimate stored hash.

### The mutation proof

The mutation test shows it concretely: pre-fix, calling
`hasher.verify("anything", "scrypt-v1:salt:???")` returns
`true`. ANY password verifies against that stored hash.
Post-fix it returns `false`.

This iter's defect class — **lenient base64 decode in a
timing-equal security path; zero-length Buffer collapses to a
trivial-true comparison** — is fresh. The closest sibling is
goal 637 (loopback-crypto base64 decode validation, lenient
Buffer.from in a non-security path), but the impact bracket is
completely different: 637 was "garbled output instead of
error", this is "auth bypass on corrupted stored credential".
Sibling pattern, distinct severity, distinct surface.

Against the recent window:

- 637: lenient base64 decode (loopback tool, non-security)
- 636: HTTP timeout
- 635: per-file concurrent write (memory store)
- 634: sort tiebreaker
- 633: surrogate-pair truncation
- 632: tilde-expansion
- 631: per-file concurrent write (messaging)
- 630: mkdtemp directory cleanup
- 629: per-entry validation
- 628: unit-promotion + finite-guard

## Slice

- `packages/auth/src/index.ts:PasswordHasher.verify`:
  - Add a length-pin check immediately after decoding
    `expected`: `if (expected.length !== passwordKeyLength)
    return false;`. `passwordKeyLength` is the file-local
    constant set to 64 (the scrypt output length used by
    `hashPassword`).
  - Replace the redundant `actual.length === expected.length
    && timingSafeEqual(...)` guard with the simpler
    `timingSafeEqual(actual, expected)` — `actual` is computed
    as `scryptSync(password, salt, expected.length)` so it
    always has `expected.length` bytes by construction, and
    we've just verified `expected.length === passwordKeyLength`.
  - A short WHY comment documents the threat model (the
    file's only comment is intentional — this is a non-derivable
    security invariant).
- `packages/auth/test/auth-hardening.test.ts`:
  - One new test in the existing `PasswordHasher` describe.
    Four assertions:
    1. **Pure-invalid base64url** — `"scrypt-v1:salt:???"`
       decodes to 0 bytes; pre-fix this auth-bypassed. Post-
       fix rejects, regardless of the password supplied.
       Verify with `"anything"`, `""`, and `"muse-jarvis"`.
    2. **Different all-invalid** — `"scrypt-v1:salt:!!!!"`
       (different non-base64url chars). Same outcome.
    3. **Short-but-valid base64url** —
       `"scrypt-v1:salt:abc"` decodes to ~3 bytes, far from
       the 64-byte expected. Pre-fix the
       `actual.length === expected.length` would have caught
       this (both 3), but only by coincidence — post-fix
       rejects on the explicit length-pin contract.
    4. **Happy path regression pin** — a real hash from
       `hashPassword` still verifies. The fix doesn't
       regress legitimate inputs.

## Verify

- `@muse/auth` suite green (40 passed, +1 vs the pre-iter
  baseline of 39, 0 failed).
- **Clean-mutation-proven** (Edit-based): reverting the
  length-pin back to the `actual.length === expected.length`
  comparator makes the new test fail with the EXACT auth-
  bypass symptom: `expected true to be false` — the pre-fix
  `verify("anything", "scrypt-v1:salt:???")` returned `true`.
  The pre-existing 39 tests (including the original "rejects
  malformed hashes" test) pass both pre- and post-fix —
  confirms the fix is surgical to the lenient-base64-decode
  branch.
- `pnpm check` green: apps/api 261/261, apps/cli 1101/1101,
  every workspace; tsc strict EXIT=0.
- `pnpm lint` 0/0, `pnpm guard:core` clean, byte-scan clean
  on both touched files.
- No LLM request/response wire path touched. `smoke:live`
  doesn't apply (this is the credential storage path, not the
  model wire).

## Status

Done. Password verification is now length-pinned against the
exact scrypt output (64 bytes), closing the lenient-decoder
auth-bypass:

| Stored `passwordHash`                 | Before                       | After                        |
| ------------------------------------- | ---------------------------- | ---------------------------- |
| Healthy (64-byte hash)                | verify(correct) → true       | unchanged                    |
| Healthy + wrong password              | verify(wrong) → false        | unchanged                    |
| `scrypt-v1:salt:` (empty hash)        | false (`!hash` catch)        | unchanged                    |
| **`scrypt-v1:salt:???`** (zero-decode) | **verify(ANY) → true** (bypass) | false (**fixed**)         |
| `scrypt-v1:salt:abc` (3-byte decode)  | false (coincidental mismatch)| false (explicit length-pin)  |
| Version mismatch (`v999:salt:hash`)   | false                        | unchanged                    |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a security
hardening `fix:` on the authentication chokepoint. Recorded
honestly with this backlog row — a critical-severity fix that
warranted a single-iteration focus.

## Decisions

- **Length-pin to `passwordKeyLength` (64), not just
  `> 0`.** The tighter check is functionally equivalent for
  the bypass case (decode-to-0) but also rejects the
  decode-to-N-where-N!==64 case as an explicit contract.
  Defense-in-depth — if a future migration changes
  `passwordKeyLength`, the `passwordHashVersion = "scrypt-v1"`
  prefix gates the rotation; old hashes would still hit the
  version branch and fall through cleanly.
- **Kept the WHY comment** despite the project's "default to
  no comment" rule. This is exactly the case the rule allows:
  "a non-obvious constraint or invariant (a hidden security
  invariant that's lost without context)". A maintainer
  reading the function in isolation would see `expected.length
  !== passwordKeyLength` as a strange-looking guard;
  the comment names the lenient-decode bypass it closes.
- **Removed the `actual.length === expected.length` guard.**
  After the length-pin, `expected.length === 64` is
  guaranteed. `scryptSync(_, _, 64)` returns exactly 64
  bytes. So `actual.length === expected.length` is
  tautologically true at the comparator call. Dropped to
  keep the comparator line minimal — `timingSafeEqual` would
  throw if the lengths didn't match (which can't happen
  post-pin), so the explicit check is redundant.
- **Test asserts the bypass with multiple bad inputs.** A
  single `???` example might look like an edge case; four
  assertions across `???`, `!!!!`, and `abc` make the contract
  generalizable and pin the regression test against future
  changes.
- **Did NOT also harden the `hash` value at write time.**
  `hashPassword` always produces valid base64url (it's
  `scryptSync(...).toString("base64url")`). The defect is at
  the READ boundary, where the stored hash could already be
  corrupt before we see it. No write-side change needed.
- **Mutation choice.** Reverted only the length-pin (the 3
  added lines and the trailing comparator change). One test
  fails with the exact bypass symptom (`expected true to be
  false`). The other 39 tests pass both pre- and post-fix —
  confirms the fix is purely additive on the legitimate path.

## Remaining risks

- **`KyselyUserStore` reads the hash from Postgres**. The
  Postgres column is `TEXT NOT NULL`, but nothing in the
  schema validates the base64url shape. Same defect class
  could apply if the column gets corrupted; the verify
  length-pin catches it post-load. No DB-level constraint
  added — would need a CHECK constraint that's vendor-
  specific.
- **Timing-equal comparison still happens** even on the
  rejected path (the `timingSafeEqual` call doesn't run, but
  the `expected.length !== passwordKeyLength` check happens
  before any expensive scrypt call). A timing-attack adversary
  could potentially distinguish "version mismatch" from
  "length mismatch" from "scrypt mismatch" — but the salt is
  per-user, so this gives no useful info even with perfect
  timing observation. Defense-in-depth: pre-pin we computed
  scryptSync even for malformed hashes; post-pin we skip the
  scrypt call when length-mismatched. Net positive (less work
  for malformed inputs, slightly faster fail).
- **No checksum / HMAC over the stored hash record.** A
  bit-flip in the salt OR version field would surface as a
  legitimate "wrong password" verdict, which is correct. A
  bit-flip in the version field would fall to the version-
  mismatch branch — correct. A bit-flip in the hash field
  itself most likely produces a wrong-length decoded Buffer
  (caught by the length-pin) OR a same-length-but-wrong
  Buffer (caught by `timingSafeEqual`). No extra integrity
  check needed.
- **Future scrypt output length change.** If
  `passwordKeyLength` is bumped from 64 to 128, old hashes
  (still 64 bytes after decode) would fail the new length-pin
  with the new code. That's the correct behavior — old
  hashes need re-hashing on next login. The `passwordHashVersion`
  string is the migration gate; bumping it (`"scrypt-v1"` →
  `"scrypt-v2"`) lets `verify` route old hashes through a
  compatibility shim if needed. Out-of-scope for this iter.
