# 435 — Pin the LINE webhook wrong-length-signature → clean-401 (DoS guard)

## Why

Security-robustness coverage gap. The inbound LINE webhook
(`apps/api/src/messaging-webhooks-routes.ts`) verifies
`X-Line-Signature` with an HMAC-sha256 + `safeEquals`, which
length-guards before `timingSafeEqual`:

```ts
if (aBuf.length !== bBuf.length) return false;   // ← without this…
return timingSafeEqual(aBuf, bBuf);              // …throws on unequal length
```

`timingSafeEqual` **throws** ("Input buffers must have the same
byte length") on unequal-length inputs. The length-guard converts
a wrong-length / non-base64 forged signature into a clean `401
MESSAGING_WEBHOOK_BAD_SIGNATURE` instead of an unhandled throw →
`500`. An attacker probing the public webhook with junk
signatures must get clean 401s, never crash the endpoint — a
removed guard would be a **DoS** vector and a real auth-path
regression.

The existing tests covered valid, missing-header (UNSIGNED), and
wrong-secret — but `sign("different-secret", body)` produces a
**correct-length** (44-char base64) wrong HMAC, so it never
exercises the length-mismatch path the guard exists for.
Implicit-only coverage of a security guard — exactly what
`.claude/rules/testing.md` forbids (407/424/434 precedent).
Non-speculative: the guard is correct; this pins it so a refactor
can't silently re-introduce the 500/DoS.

## Slice

- `apps/api/test/messaging-webhooks.test.ts` — extend the
  existing "rejects with 401 when X-Line-Signature is missing or
  wrong" test: three forged signatures of the wrong shape
  (`"abc"`, a 200-char run, a non-base64 string with spaces) each
  must return `statusCode === 401` and
  `code === "MESSAGING_WEBHOOK_BAD_SIGNATURE"` (not 500), and no
  inbox file is written. Co-located with the sibling auth-reject
  assertions (same theme); deterministic via `server.inject`.

## Verify

- `@muse/api` messaging-webhooks.test.ts 4/4 (the auth-reject
  test now also pins the malformed-signature → clean-401 branch);
  full `@muse/api` suite green (195); tsc strict (api) clean.
- `pnpm check` EXIT=0, every workspace green (api 195, cli 737,
  …); `pnpm lint` 0/0; `pnpm guard:core` clean; byte-scan clean;
  `git status` shows only the test file (no `src` change).
- Deterministic HTTP-injection test — not a model
  request/response path; no `smoke:live` applies.

## Status

Done. The LINE webhook's signature length-guard — the line that
keeps a forged junk signature from crashing the public endpoint
(`timingSafeEqual` throw → 500) — is now directly pinned. A
refactor that drops it now fails a fast test instead of opening a
DoS / auth-robustness regression.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]`; security-coverage hardening of an existing guard,
recorded honestly as a `test(api):` change with this backlog row
— not a false metric. Same discipline as goals 407 / 424 / 434.

## Decisions

- Extended the existing auth-reject test rather than adding a new
  describe: the malformed-signature case is the same security
  concern (forged inbound → must reject cleanly) and belongs
  beside the missing/wrong-secret assertions — one coherent
  "the webhook rejects every bad signature shape safely" test,
  not scattered coverage.
- Three distinct junk shapes (too-short, too-long, non-base64
  with spaces) rather than one: the guard's correctness is
  length-independent, and pinning the spread documents that ANY
  malformed signature is a clean 401, not just one example.
