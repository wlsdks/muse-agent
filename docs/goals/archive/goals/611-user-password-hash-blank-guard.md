# 611 — `normalizeUserInput` rejects blank `passwordHash` with `INVALID_USER`, matching the existing email / name blank-input guards so an empty hash never enters the store

## Why

`packages/auth/src/user-stores.ts:normalizeUserInput` is the single
boundary every user record passes through on its way into the store
(both `InMemoryUserStore.save` / `update` and
`KyselyUserStore.save` / `update` route through here via
`normalizeUserInput` + `createUserInsert`). The function already
rejects two blank inputs:

```ts
if (!email) {
  throw new AuthError("INVALID_USER", "User email must not be blank");
}
if (!input.name.trim()) {
  throw new AuthError("INVALID_USER", "User name must not be blank");
}
```

But `passwordHash` was passed straight through:

```ts
return {
  ...,
  passwordHash: input.passwordHash
};
```

A caller (a bug in a registration flow, a CLI sketch, a test
fixture, a hand-edited DB migration) that hands the store
`passwordHash: ""` would create a User record with no credential.
Downstream `DefaultAuthProvider.authenticate(account, password)`
runs the configured `PasswordHasher.verify(suppliedPassword,
storedHash)` — with a blank hash, the verifier's behavior depends
on the hash function (some libraries return `false`; some throw;
some incorrectly accept). At best you get a permanently
unauthenticatable account; at worst, an account that's
trivially bypassable.

The right posture for a credential field is the same as the
already-validated identity fields: refuse blank at the boundary
so the broken state never enters the store. Three lines, mirror
the existing pattern, same error code (`INVALID_USER`), same
"must not be blank" message style.

Step-8 redirect: recent classes (610 SLO validation, 609 cost
clamp, 608 integer precision, 607 state observability, 606 BOM,
605 dedup, 604 memory cap, 603 CLI empty-id, 602 Invalid-Date,
601 regex). 610 was constructor-validation parity in observability;
this is field-validation parity in auth — different package,
different surface (auth boundary vs metric configurator), but
the same "the sibling fields are already validated, this one was
missed" defect shape. Fresh enough for one iter.

## Slice

- `packages/auth/src/user-stores.ts:normalizeUserInput`:
  - Added a third validation check, mirroring the existing
    email / name checks line-for-line:
    ```ts
    if (!input.passwordHash.trim()) {
      throw new AuthError("INVALID_USER", "User passwordHash must not be blank");
    }
    ```
  - The check sits between the name validation and the return
    statement, in the same order as the field appears in the
    `User` interface. `.trim()` rejects pure-whitespace inputs
    (`"   "`, `"\t\n"`) along with the empty string — same
    semantic the sibling `name` check uses.
  - Both `InMemoryUserStore` and `KyselyUserStore` benefit
    automatically since both route through this function via
    `normalizeUserInput` + `createUserInsert`.
- `packages/auth/test/auth.test.ts`:
  - One new test in the `users and password auth` describe.
    Loops over `["", "   ", "\t\n"]` and asserts each
    `store.save(...)` throws with the "passwordHash must not be
    blank" message. Pins the post-throw invariant
    `store.count() === 0` so a partial save state can't survive
    the rejection. Tail-asserts a non-blank hash still saves
    cleanly.

## Verify

- `@muse/auth` suite green (39 passed, +1 vs baseline 38, 0
  failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): removing the new
  three-line block makes the test fail with `expected
  INVALID_USER for passwordHash="": expected [Function] to
  throw an error` — exactly the silent-acceptance symptom
  documented above (the empty hash passes through and the
  store creates a credential-less user record).
- `pnpm check` EXIT=0 (apps/api 258 passed, apps/cli 1041
  passed, every workspace green); `pnpm lint` 0/0; `pnpm
  guard:core` clean; byte-scan clean on both touched files;
  `git status` shows only the two intended files plus this
  goal doc.
- No LLM request-response wire path touched; `smoke:live` does
  not apply. The user store boundary is an in-process write
  path, not HTTP-exercised by `smoke:broad`.

## Status

Done. The `normalizeUserInput` boundary now refuses every blank
identity field uniformly:

| Field         | Before                                  | After                       |
| ------------- | --------------------------------------- | --------------------------- |
| `email`       | throws on blank (`INVALID_USER`)        | unchanged                   |
| `name`        | throws on blank (`INVALID_USER`)        | unchanged                   |
| **`passwordHash`** | **silently accepted** (broken row) | throws on blank (**fixed**) |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a
boundary-validation parity `fix:` on the user-store ingestion
seam, recorded honestly with this backlog row — not a false
metric.

## Decisions

- **Same error code (`INVALID_USER`) and message style** as
  the sibling email / name checks. A caller catching
  `AuthError` only needs to switch on the code; matching the
  existing pattern means the new throw blends in without
  forcing a new branch.
- **`.trim()` semantics**, not just `!== ""`. Pure-whitespace
  hashes are as broken as the empty string and surface from
  the same authoring mistakes (a blank input field that the
  caller didn't trim). The sibling `name` check uses the same
  posture; consistency.
- **Validate in `normalizeUserInput`**, not in
  `InMemoryUserStore.save` / `KyselyUserStore.save` directly.
  The store classes both delegate to `normalizeUserInput` /
  `createUserInsert`, so one check covers all entry points.
  Validating in the leaf would force the same throw at every
  caller site.
- **No coupling to a specific hash format.** I considered
  asserting a prefix like `$2b$` (bcrypt) or a versioned
  `v1:salt:hash` schema, but the auth package supports an
  injectable `PasswordHasher` — pinning a format would lock
  out custom implementations. Blank-rejection is the
  format-agnostic minimum.
- **Test reuses the existing `users and password auth`
  describe.** That block already pins save/update behavior;
  adding the negative-case sits naturally alongside.
- **Asserts `count() === 0` post-rejection.** A throw that
  half-mutated the store (e.g. inserted into `usersById`
  before the validation fired) would leave a ghost record.
  The pre-store-mutation order of `normalizeUserInput`
  guarantees the throw happens before any `set` call, but
  pinning the invariant in the test means a future refactor
  that re-orders the calls would fail this assertion.
- **Mutation choice.** Reverted exactly the three-line block.
  The mutation reproduces the pre-fix shape — the realistic
  regression a maintainer might write while "trimming the
  three-line guard because the field is typed string anyway."
  The mutation test catches that misjudgment.

## Remaining risks

- **The `update()` path on both stores** also routes through
  `normalizeUserInput` (via `createUserInsert`), so an
  `update()` that clears the password is also rejected. If a
  future "remove user's password" flow becomes a real need,
  it would have to use a dedicated `clearPassword(id)` method
  rather than `update({ passwordHash: "" })` — explicit,
  observable, and unable to bypass the credential check
  accidentally.
- **`hashPassword`'s output** isn't shape-validated here.
  A `PasswordHasher` implementation that returns an
  improperly-formatted-but-non-blank string would still pass
  this gate. That's a contract concern for `PasswordHasher`
  implementations, not the user store.
- **No length floor.** A 1-character non-blank hash passes
  (`"x".trim() === "x"`). Defending against truncated hashes
  would require pinning a hasher format; out of scope per the
  decision above.
- **OAuth / SSO users** that legitimately don't have a
  password would need a new "no-password user" flow if Muse
  ever supports them. Today the User type requires
  `passwordHash: string`; that contract is unchanged.
