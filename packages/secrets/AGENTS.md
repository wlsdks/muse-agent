# `@muse/secrets` — credential handling

Never commit a live credential, never log one, and never put one in a handoff, a test fixture, or
a commit message. Reading or copying credentials is outside what an evaluator or any delegated
agent may do.

Encryption at rest is **opt-in and off by default** — do not describe it as always-on. The
envelope exists (`MUSE_CREDENTIALS_ENCRYPT`), the default is plaintext, and
[`docs/trust/privacy-and-data.md`](../../docs/trust/privacy-and-data.md) owns that fact.

Any change here is a security surface: it requires an independent evaluator in a separate
instance, not a self-review.

Repository-wide brief: [`AGENTS.md`](../../AGENTS.md).
