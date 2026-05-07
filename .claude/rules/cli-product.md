# CLI product surface

The CLI is not a wrapper afterthought. Server and CLI share the same
`packages/agent-core` runtime — same guard semantics, same hook
contracts, same approval gates.

## Stack

- Command parser: `commander`
- Interactive prompts: `@clack/prompts`
- Full terminal UI: Ink

## Storage paths

- User config: `~/.config/muse/config.json`
- Workspace run state: `.muse/runs/*.jsonl`
- Credentials: OS keychain or encrypted auth store

## Modes

- **Local**: execute `packages/agent-core` in the CLI process.
- **Remote**: connect to the API server over SSE.
- Risky local execution always goes through `crates/runner` as a child process.

## What not to do

- Don't fork agent behavior between CLI and server. Same runtime, same contracts.
- Don't store API tokens in plain text — use the keychain or the encrypted auth store.
- Don't ship a CLI feature without unit tests for the command parser and a smoke test for the run path.
