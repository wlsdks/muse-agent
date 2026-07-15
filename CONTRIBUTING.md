# Contributing to Muse

Muse is a personal-JARVIS-style AI conductor — provider-neutral, tool /
MCP first, deterministic safety. Every change is one focused goal with
full verification before commit. Outside contributions follow the same
discipline.

## Before you start

Read these in order:

1. [`README.md`](README.md) — what Muse is and what runs out of the box.
2. [`AGENTS.md`](AGENTS.md) — cross-agent product brief.
3. [`CLAUDE.md`](CLAUDE.md) — the contract every agent (and human)
   reads first; under 100 lines, points at the rule files below.
4. [`.claude/rules/`](.claude/rules/) — domain-specific rules
   (architecture, testing, commits, code style, CLI product).
   Each is short and load-bearing — when a change violates a rule,
   the rule moves up the priority list.

## Local setup

```bash
# Requirements: Node.js 24 LTS + pnpm 10
pnpm install
pnpm check:toolchain
pnpm build
pnpm test
```

The repo is a pnpm workspace; every package builds with `tsc -p
tsconfig.json` and tests with `vitest run`.

Compilation uses the TypeScript 7 native compiler. The `typescript` dependency is
intentionally the official TypeScript 6 compiler-API compatibility alias for tooling;
do not replace it during ordinary dependency updates. See
[`docs/development/typescript-7.md`](docs/development/typescript-7.md) for the
supported migration and verification procedure.

## Verification gates (cheapest first)

Run from the repo root unless noted:

```bash
pnpm --filter @muse/<name> test    # narrow: one package while iterating
pnpm check                         # build + test for every workspace
pnpm lint                          # ESLint flat config (0 errors / 0 warnings)
pnpm smoke:broad                   # 47 HTTP endpoints, diagnostic provider
GEMINI_API_KEY=… pnpm smoke:live   # 12 endpoints, real LLM round-trip
```

Don't ship a request/response-touching change without a real
`smoke:live` pass. Diagnostic-provider smoke catches shape errors
but never exercises the actual model contract.

## Making a change

- **One focused goal per PR.** Bug fix, dead-code removal, big-file
  decomp, or a single feature. Refactors and feature work don't mix.
- **Conventional Commits** — `feat:`, `fix:`, `refactor:`, `test:`,
  `docs:`, `chore:`. Subject + body in English (the rest of the
  product can be Korean — code metadata stays English so tooling and
  multi-locale contributors stay aligned).
- **No emojis in source / commit messages.** The CLAUDE.md no-emoji
  rule applies to humans and agents alike.
- **Tests are the only form of verification.** Add the narrowest
  useful test (unit before integration before HTTP smoke) for every
  new behavior.
- **Lint is `error`-only.** All eleven rules in `eslint.config.js`
  block `pnpm lint` exit-0. New violations don't ship.

## Provider credentials

Never commit live credentials. The repo contains no private keys,
no Jira / Confluence / Bitbucket / Slack workspace credentials, and
no hardcoded API keys for any model provider. Calendar / notes /
tasks providers and the model registry all read keys from the
environment at runtime.

If you need a key for local dogfood:

- Personal: export it in your shell (e.g. `GEMINI_API_KEY=…`).
- CI: add it as a repository secret and reference via `env:` in
  the workflow.

## Reporting a security issue

Don't open a public issue for security problems. See
[`SECURITY.md`](SECURITY.md) for the private-disclosure flow.

## Code of conduct

This project adopts the
[Contributor Covenant 2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).
See [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). Reports go through
GitHub's private security advisory channel, same path as
non-security incidents — see the linked file for the URL.

## License

MIT. See [`LICENSE`](LICENSE). By contributing you agree to license
your contribution under the same terms.
