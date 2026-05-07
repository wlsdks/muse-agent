# Migration redaction rules

When moving code, docs, prompts, fixtures, reports, or examples from
Reactor into Muse, redact private or identifying material before
committing.

## Redact or generalize

- Personal names, usernames, emails, phone numbers, addresses, account identifiers.
- Company, customer, vendor, team, workspace, tenant, Slack, Jira, GitHub, or domain names.
- API keys, tokens, secrets, hostnames, connection strings, internal URLs, private repository paths.
- Business-specific prompt examples, reports, traces, or fixtures that reveal real organizations or people.

## Synthetic replacements

- Users: `example-user`
- Tenants: `example-tenant`
- Workspaces: `sample-workspace`
- Domains: `example.com`
- Atlassian: `https://example.atlassian.net/...`

## Allowed as-is

Public model provider names — OpenAI, Anthropic, Google Gemini,
OpenRouter, Ollama — are allowed when documenting public adapter
support.

If redaction would make a behavior test meaningless, keep the behavior
and rewrite the fixture with synthetic data. If a value might identify
a person or organization, do not migrate it as-is.
