# Security Policy

## Supported versions

Muse is in continuous iteration on `main`. There are no released
versions yet — the supported branch is `main`. Security fixes land
there directly.

## Reporting a vulnerability

**Don't open a public issue.** Use GitHub's private security
advisory flow instead:

https://github.com/wlsdks/muse-agent/security/advisories/new

What to include:

- A description of the issue and its impact (read access? remote
  code execution? credential leak? denial of service?).
- Steps to reproduce, ideally a minimal proof-of-concept against
  `main`.
- Affected components — `apps/api`, `apps/cli`, `apps/web`, a
  specific package under `packages/`, or `crates/runner`.
- Whether the issue is exploitable in the default configuration
  (no extra credentials, no opt-in tools), or only when a specific
  feature is enabled (`MUSE_USER_MEMORY_AUTO_EXTRACT=true`,
  external MCP server, calendar OAuth, etc).

You should expect an acknowledgment within 7 days. A fix or a
public disclosure timeline will follow once the report has been
triaged.

## Threat model — what's in scope

Muse is designed to run **as a single user, on the user's own
machine or trusted server**. Multi-tenant isolation is explicitly
not a goal (see `.claude/rules/product/product-identity.md` — a personal agent for
one person, not a workspace). With that scope:

In scope for security reports:

- Remote code execution from a model response, tool result, or
  MCP server payload.
- Path traversal that escapes the configured `MUSE_NOTES_DIR` /
  `MUSE_TASKS_FILE` / `MUSE_CALENDAR_FILE` boundary.
- SSRF via the loopback `muse.fetch` server or an MCP transport
  that doesn't honor the `allowPrivateAddresses` policy.
- Credential leakage — keys / tokens written to logs, error
  messages, or HTTP responses.
- Prompt-injection bypasses that defeat the deterministic input /
  output guard pipeline (`packages/policy`).
- Denial of service via unbounded tool loops, runaway streaming,
  or context-window exhaustion.

Out of scope:

- Running Muse with `MUSE_MCP_ALLOW_PRIVATE_ADDRESSES=true` and
  pointing it at a malicious local server. That's the user opting
  out of the default protection.
- Hostile model providers — if you point Muse at a custom
  OpenAI-compatible endpoint that returns malicious tool calls, the
  guards still apply but the risk model is different.
- Attacks that require already having shell access on the host.

## Coordinated disclosure

Once a fix is merged, the advisory will be published with credit
to the reporter (unless you ask to remain anonymous). CVE
assignment will be requested for vulnerabilities that affect the
default configuration.
