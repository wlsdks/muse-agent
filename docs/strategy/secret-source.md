# SecretSource — design

> Status: DESIGN (for review). Picked 2026-06-30 by Jinan from the openclaw/hermes CONVERGENCE
> analysis — the one capability BOTH rivals independently built that Muse genuinely lacks (openclaw
> `src/secrets/` + 1Password skill; hermes `agent/secret_sources/bitwarden.py` + `credential_pool.py`
> + `secret_scope.py` + `redact.py`). Convergence = essential signal. Pattern reimplemented
> Muse-native, not copied.

## 1. The problem

Muse ACTS on the world — sends email, posts messages, reads calendars — so it needs secrets (OAuth
tokens, API keys, app passwords). Today each service keeps its OWN copy: `calendar/credential-
store.ts`, `messaging/credential-store.ts`, `official-mcp-credentials.ts` — single-file chmod-600
JSON silos. So the user's secrets are RE-ENTERED per service and Muse becomes yet another credential
store holding a SECOND plaintext-ish copy of every secret, scattered across packages.

The clean pattern (both rivals converged on it): instead of being a credential silo, **read the
secret on demand from the vault the user ALREADY keeps** — their OS keychain or password manager —
and never hold a second copy.

## 2. What SecretSource is

A single seam Muse asks "give me the secret named X" and it is resolved, on demand, from an ordered
chain of LOCAL sources — the user's existing vault first, the legacy per-service store as a
fallback. The raw secret is used by the ADAPTER that performs the action; it never enters the model
prompt and is masked everywhere it could be logged.

```ts
interface SecretRef { readonly name: string; readonly service?: string; } // logical handle
interface SecretSource {
  readonly id: string;                 // "keychain" | "1password" | "bitwarden" | "env" | "store"
  get(ref: SecretRef): Promise<string | undefined>;   // undefined ⇒ this source doesn't have it
  readonly local: boolean;             // true for keychain/op/bw/env — a non-local source is refused
}
// The resolver tries sources IN ORDER, read-on-demand, returns the first hit (or undefined).
function resolveSecret(ref, sources): Promise<string | undefined>;
```

## 3. The pieces (Muse-native)

- **Sources (adapters)**, each a thin read-only reader of a LOCAL vault:
  - `env` — `MUSE_SECRET_<NAME>` (the simplest, for headless/CI).
  - `keychain` (macOS) — `security find-generic-password -w -s <service> -a <name>` via a controlled
    subprocess (a FIXED executable + args, never a shell string). Ships first (zero install on Mac).
  - `1password` — `op read "op://<vault>/<item>/<field>"`. Phase 4.
  - `bitwarden` — `bw get password <name>` (session-token gated). Phase 4.
  - `store` — the existing per-service credential stores, so nothing breaks during migration.
- **Redaction** (`redactSecrets`): a pure function + a process-wide registry of resolved secret
  VALUES; every log / action-log / provenance / grounding sink runs values through it so a secret is
  written as `‹secret:NAME›`, never in clear. Resolved values register on resolve, deregister never
  (a secret seen once stays masked for the process).
- **Scoping** (`SecretScope`): least-privilege — a tool/action declares the secret names it may read;
  the resolver refuses a `get` outside the declared scope. So a Telegram-send tool can't read the
  Gmail password.

## 4. Hostile review (security is the whole point — a leak here is severe)

1. **A secret must NEVER reach a model / cloud (the #1 invariant).** The resolved value flows ONLY
   to the adapter performing the action — it is never put in a prompt, a tool ARG visible to the
   model, or a tool result. Acceptance: a run that uses a secret has it absent from every
   ModelMessage + every grounding source; under `MUSE_LOCAL_ONLY` nothing changes (secrets were
   never going to the model anyway). A non-`local` source is REFUSED (no "fetch my secret from a
   cloud vault API" — that would egress the secret).
2. **No second plaintext copy / no caching to disk.** `get` reads on demand and returns a string;
   the resolver does NOT persist it. The only at-rest copy is the user's vault (and the legacy store
   we're superseding). Acceptance: after a resolve, grep the Muse data dir — the secret value is not
   newly written anywhere.
3. **Redaction is fail-closed at the log boundary.** Every secret value resolved is registered and
   masked in EVERY sink. Acceptance: resolve a secret, then log/append-action a string containing it
   → the persisted text shows `‹secret:NAME›`, not the value. A mutation that bypasses the redactor
   makes this test RED.
4. **Subprocess safety.** The vault CLI is spawned with a FIXED argv array (no shell, no
   interpolation of untrusted text into the command) — a secret NAME that contains shell metachars
   can't inject. The executable is an allowlisted vault binary. A missing/locked vault ⇒ `undefined`
   (fail-open to the next source), never a crash or a partial.
5. **Scope is fail-closed.** An out-of-scope `get` returns undefined + records a denied access; it
   does not silently widen. outbound-safety unchanged — a secret enables an action that STILL passes
   the draft-first approval gate.
6. **Out of scope (hard):** banking / payment / money-movement secrets — Muse does not connect to
   bank/brokerage accounts (`outbound-safety.md`). SecretSource reads what the user already has; it
   never creates a path to move money.

## 5. Phased build (each a verifiable slice, maker≠judge)

1. **Interface + resolver + redaction primitive** (pure, no subprocess): `SecretSource`/`SecretRef`,
   `resolveSecret` (ordered, read-on-demand, refuses a non-local source), `redactSecrets` + the
   value registry. Deterministic unit tests + the redaction mutation test.
2. **macOS keychain adapter + env + store adapters** (controlled subprocess, FIXED argv; mocked in
   tests): a keychain miss ⇒ undefined ⇒ next source; argv-injection attempt is inert.
3. **Scoping + redaction WIRING into the live log/action-log/provenance sinks** — a resolved secret
   is masked in every persisted sink; an out-of-scope get is refused. The "secret never in a model
   message / grounding source" acceptance.
4. **1Password (`op read`) + Bitwarden (`bw get`) adapters** (mocked), behind their own opt-in env.
5. **Wire the resolver into the live outbound credential-fetch path** (calendar/messaging/email get
   their secret via `resolveSecret` with the legacy store as the fallback source — zero breakage) +
   an e2e + `muse doctor` reporting the configured sources + docs.

## 6. Open decisions for Jinan

- **keychain first, then 1Password, then Bitwarden** — confirmed. Bitwarden may slip to a follow-up.
- **Redaction registry is process-wide + grow-only** (a value seen once stays masked) — recommended
  (a freed secret could still sit in a buffer); confirm.
- Branch `feat/secret-source`, Tier1 (local commits, no push), built phase-by-phase by a loop.
