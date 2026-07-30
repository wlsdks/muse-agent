# @muse/shared

Cross-cutting primitives with no framework or product dependency: run identity, secret
redaction/persistence guards, error/JSON/string utilities, trigger and daemon-delivery-brake
state machines, and the decision/personal-status admission types other packages build on.

## Public surface

- `.` (`src/index.ts`) — the full primitive surface: `createRunId`, `sha256Hex`/`hmacSha256Hex`/
  `verifyHmacSha256Hex`, `stripUntrustedTerminalChars`, `redactSecretsInText`,
  `formatErrorForTerminal`, `closestCommandName`, `resolveHomeDir`, plus re-exports for secret
  redaction (`redactSecrets`, `registerSecretValue`), the secret-persistence guard
  (`guardSecretPersistence`), platform capabilities, credential encryption
  (`encryptCredentialEnvelope`/`decryptCredentialEnvelope`), trigger envelopes/admission/work-state,
  loop-supervisor health, JSON/error utilities, and the `DecisionMetric` / `PersonalStatus`
  admission contracts.
- `./browser` (`src/browser.ts`) — a browser-safe subset for `apps/web`.

## Depends on

No internal `@muse/*` dependencies — this is the base of the dependency graph; every other
workspace package may depend on it, but it depends on nothing in-repo.

## Rules that bind this package

- Model-agnostic and framework-independent, per `../../.claude/rules/engineering/architecture.md` — no
  vendor SDK or UI framework import belongs here.
- `redactSecretsInText` / `registerSecretValue` / `guardSecretPersistence` are the shared
  redaction seam every other package's persistence and terminal output funnels through; changing
  their behavior changes what can leak into logs or disk across the whole monorepo.
- `stripUntrustedTerminalChars` / `formatErrorForTerminal` treat all tool/model/HTTP output as
  untrusted per `../../.claude/rules/engineering/architecture.md`'s "tool output is untrusted" rule.

## Tests

`pnpm --filter @muse/shared test`
