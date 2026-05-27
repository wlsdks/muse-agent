# 620 — `readStoredToken` degrades to `undefined` + a stderr warning on a corrupted credentials file instead of throwing — every auth-aware CLI command falls back to anonymous mode rather than crashing with a raw JSON SyntaxError

## Why

Goal 617 closed the *write* dimension of the credential store
(atomic `tmp+rename` so a crash mid-write never corrupts the
existing file). But corruption can ALSO arrive from:

- A user manually editing `~/.config/muse/credentials.json` and
  saving a malformed file.
- Disk corruption that lands AFTER goal 617's rename completes.
- A partial write that pre-dates the 617 fix (the user upgraded
  Muse but their store was already half-written before the
  upgrade landed).
- A foreign tool (a cleanup script, a sync daemon) truncating the
  file.

Pre-fix `readCredentialStore`:

```ts
async function readCredentialStore(io: ProgramIO): Promise<CredentialStore> {
  try {
    const raw = await readFile(credentialPath(io), "utf8");
    const file = JSON.parse(raw) as unknown;        // ← throws on ""
    if (!isEncryptedCredentialFile(file)) {
      throw new Error("Invalid Muse credential store format");
    }
    // ...
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { tokens: {} };
    }
    throw error;
  }
}
```

The catch handles ONLY `ENOENT`. Any other failure — `JSON.parse`
SyntaxError on empty / malformed content, shape mismatch on a
non-credential JSON file, decrypt failure — propagates straight
through `readStoredToken` to the calling command. The user
running `muse chat hello` against a corrupted file sees:

```
SyntaxError: Unexpected end of JSON input
    at JSON.parse (<anonymous>)
    at readCredentialStore (.../credential-store.ts:86)
    ...
```

Every auth-aware command crashes the same way until the user
manually `rm`s the file. The right behavior on the READ path is
"degrade to anonymous mode + warn loudly so the user can fix" —
exactly the same posture as the existing ENOENT branch, just
broader.

The WRITE paths (`writeStoredToken`, `deleteStoredToken`) MUST
keep throwing on a corrupted read — silently overwriting a
corrupted store would clobber other-baseUrl tokens that might
still be recoverable. So the fix is scoped to `readStoredToken`
only.

Step-8 redirect: not write-side atomicity (617), not file-mode
(616), not list-ordering, not finite-clamp, not validation gate.
Defect class is "graceful read-path recovery from a corrupted
local store" — fresh in the recent window.

## Slice

- `apps/cli/src/credential-store.ts:readStoredToken`:
  - Wrapped the `readCredentialStore(io)` call in a try/catch.
  - On any error, write a one-line warning to `io.stderr`
    naming the underlying error message AND the recovery path
    (`muse auth login`), then return `undefined`.
  - Short WHY comment on the read-vs-write asymmetry so a
    future maintainer doesn't "simplify" by adding the same
    catch to `writeStoredToken` / `deleteStoredToken` (which
    would mask the corruption and clobber sibling tokens).
- `apps/cli/src/credential-store.test.ts`:
  - New `readStoredToken graceful corruption recovery`
    describe with two tests:
    - **Corruption matrix** — writes 0-byte / malformed JSON /
      wrong-shape JSON to `credentials.json` in sequence and
      asserts each call returns `undefined`, the stderr buffer
      contains `credentials store unreadable` AND the recovery
      hint `muse auth login`. Pre-fix the 0-byte case throws
      `SyntaxError: Unexpected end of JSON input` (the exact
      symptom the mutation reproduces).
    - **Happy path** — no file at credentialPath; asserts
      `readStoredToken` returns `undefined` AND stderr stays
      empty (the warning fires only on real corruption, not
      on the fresh-install no-creds case).

## Verify

- `@muse/cli` suite green (1050 passed inside the package; 1052
  via `pnpm check` due to test discovery variance, +2 vs
  baseline 1048, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the
  try/catch back to the bare `return (await readCredentialStore(io))…`
  makes the corruption-matrix test fail with `SyntaxError:
  Unexpected end of JSON input` thrown from
  `credential-store.ts:86` (the `JSON.parse(raw)` call on the
  0-byte file) — exactly the pre-fix uncaught-exception symptom
  the user would see in every auth-aware command.
- `pnpm check` EXIT=0 (apps/api 258 passed, apps/cli 1052
  passed, every workspace green); `pnpm lint` 0/0; `pnpm
  guard:core` clean; byte-scan clean on both touched files;
  `git status` shows only the two intended files plus this
  goal doc.
- No LLM request-response wire path touched; `smoke:live` does
  not apply. Credential read is a local file operation.

## Status

Done. The credential read path is now resilient across every
on-disk failure mode:

| File state                                  | Before                       | After                       |
| ------------------------------------------- | ---------------------------- | --------------------------- |
| Absent (`ENOENT`)                           | `undefined` (silent)         | unchanged                   |
| Encrypted + valid                           | returns the token            | unchanged                   |
| **0 bytes (post-crash, partial write)**     | **`SyntaxError`** thrown     | `undefined` + warning (**fixed**) |
| **Malformed JSON (`"{not-json"`)**          | **`SyntaxError`** thrown     | `undefined` + warning (**fixed**) |
| **Valid JSON, wrong shape (`{"foo":1}`)**   | **`Error("Invalid Muse")`**  | `undefined` + warning (**fixed**) |
| **Decrypt failure (wrong key, garbled)**    | **decrypt error** thrown     | `undefined` + warning (**fixed**) |
| Write-path on the same corruption           | throws (unchanged)           | unchanged (still throws)    |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a robustness /
error-UX `fix:` on the credential read path, recorded honestly
with this backlog row — not a false metric.

## Decisions

- **Wrap at `readStoredToken`, not at `readCredentialStore`.**
  `readCredentialStore` is the shared helper called by BOTH
  read and write paths. Catching there would also degrade the
  write paths to silent empty-store overwrites — clobbering
  other-baseUrl tokens behind the corruption. Wrapping only
  the read path keeps writes loud (the user sees the
  corruption and decides what to do).
- **`io.stderr` for the warning, not `console.warn`.** The
  ProgramIO is already threaded through every CLI command for
  exactly this kind of out-of-band signal. `console.warn` would
  break the test harness's capture flow and bypass the user's
  `--quiet` flag (if/when added).
- **Recovery hint in the warning** (`Re-login with \`muse auth login\`
  to write a fresh store.`). A bare error message would tell
  the user something is wrong but not how to fix it. The
  hint is one short clause that turns a confusing crash into
  an actionable warning.
- **Don't silently delete the corrupted file.** Tempting —
  "auto-recovery!" — but a corrupted file might contain
  recoverable bytes (the user might want to inspect, copy a
  partial token, etc.). Strict: warn, keep the file in place,
  let the user decide.
- **Tests cover the three corruption shapes** (0-byte,
  malformed JSON, wrong-shape JSON) instead of just one.
  Each fails through a DIFFERENT internal branch (JSON.parse
  throws, isEncryptedCredentialFile rejects, decrypt rejects).
  Asserting all three pins the broad catch's coverage, not
  just one happy-mutation-path. Plus an explicit happy-path
  test for the no-file case so the warning is silent on the
  ENOENT branch.
- **Mutation choice.** Reverted exactly the try/catch wrapper
  back to the bare `(await readCredentialStore(io))…` line.
  The mutation reproduces the pre-fix shape — the realistic
  regression a maintainer might write while "simplifying the
  read path back to one line." The mutation test catches it
  with the exact `SyntaxError: Unexpected end of JSON input`
  stack trace.

## Remaining risks

- **Repeated warnings on a corrupted store** — every command
  that calls `readStoredToken` (chat, today, history, etc.)
  emits the same warning until the user re-logins. That's
  noisy but informative. A future iter could rate-limit (one
  warning per process run) if dogfood feedback says it's
  noise.
- **A determined attacker** could plant a corrupted file to
  force re-login in a phishing-style "your session expired"
  flow. Less of a vector than it sounds because the user
  reads the warning before acting, but worth noting.
- **`writeStoredToken` still throws** on a corrupted file —
  the user's `muse auth login` would fail with the same
  raw error. That's intentional (don't silently clobber)
  but the UX could be improved with a "delete + recreate?"
  prompt in the auth command itself. Separate, larger iter.
- **Decrypt failures** (correct format but wrong key) are
  treated the same as JSON corruption. A future iter could
  distinguish "wrong key, your env's `MUSE_CREDENTIAL_KEY`
  changed" from generic corruption, but the recovery path is
  the same (`muse auth login`), so consolidating is OK for
  now.
