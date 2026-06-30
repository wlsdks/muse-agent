# Loop journal — SecretSource

Theme: build SecretSource (design = docs/strategy/secret-source.md) — read the user's secrets on
demand from their existing LOCAL vault (keychain → 1Password → Bitwarden) instead of Muse being yet
another credential silo; never a 2nd copy; redaction + scoping so a secret never reaches a model or a
log. BIG chunk per fire (a whole phase). Tier1 (local commits, no push). Security is the whole point.
Convergence pick (openclaw secrets/ + 1Password; hermes secret_sources/bitwarden + credential_pool +
secret_scope + redact) — pattern, Muse-native reimplementation.

## Phases (each fire completes the next incomplete one)
- [ ] Phase 1 — interface + resolver + redaction primitive (pure, no subprocess): SecretSource/SecretRef,
      resolveSecret (ordered, read-on-demand, refuses a non-local source), redactSecrets + value registry.
      Deterministic tests + redaction mutation test.
- [ ] Phase 2 — keychain (macOS `security`, FIXED argv) + env + legacy-store adapters (mocked subprocess):
      a miss ⇒ undefined ⇒ next source; an argv-injection attempt is inert.
- [ ] Phase 3 — scoping (least-privilege fail-closed) + redaction WIRING into live log/action-log/
      provenance sinks; the "secret never in a model message / grounding source" acceptance.
- [ ] Phase 4 — 1Password (`op read`) + Bitwarden (`bw get`) adapters (mocked), opt-in env each.
- [ ] Phase 5 — wire resolveSecret into the live outbound credential-fetch path (legacy store as the
      fallback source, zero breakage) + e2e + `muse doctor` source report + docs.

## Fire log
(appended per fire)
