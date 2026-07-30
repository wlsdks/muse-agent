---
title: Architecture and repository layout
audience: [developers, AI agents]
purpose: The provider contract, where data lives on disk, the one-runtime rule, and the package map
updated: 2026-07-30
related: [../product/SYSTEM-MAP.md, ../../AGENTS.md, ../../.claude/rules/engineering/architecture.md]
---

# Architecture

## Supported models, one boundary

`agent-core` never talks to a vendor SDK. Everything goes through one `ModelProvider` interface, so
swapping models does not touch agent logic.

```ts
interface ModelProvider {
  id: string;
  listModels(): Promise<ModelInfo[]>;
  generate(request: ModelRequest): Promise<ModelResponse>;
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}
```

Adapters ship for OpenAI, Anthropic, Gemini, OpenRouter, Ollama, and supported OpenAI-compatible
endpoints. LM Studio uses that compatible adapter with a local `baseUrl`; it is not a dedicated
adapter. Select one with `MUSE_MODEL=<provider>/<model>` plus its usual API-key
variable; override explicitly with `MUSE_MODEL_PROVIDER_ID`, `MUSE_MODEL_API_KEY` and
`MUSE_MODEL_BASE_URL`. Missing capabilities degrade explicitly — no native tool calling falls back
to a strictly parsed text protocol, no structured output falls back to a parser plus validator.

No vendor owns the runtime, and no vendor is required by it. Storage and processing placement are
explicit deployment choices, not the product's identity.

## Where your data lives

| What | Where |
| --- | --- |
| Notes | `~/.muse/notes/` |
| Tasks | `~/.muse/tasks.json` |
| Reminders | `~/.muse/reminders.json` |
| Memory | `~/.muse/user-memory.json` |
| Config | `~/.config/muse/config.json` |
| Run state | `.muse/runs/*.jsonl` |

Plain files. Memory, episodes and the action log are encrypted at rest; credentials live in the OS
keychain or an encrypted auth store, never in plain text.

## One runtime, every surface

CLI, web/API chat, messaging channels, scheduled jobs and delegated workers all share the same
composition root — the same guards, approvals and traces. Risky local execution goes through the
Rust `runner` as a child process. Tool output is treated as untrusted input, and every tool loop has
an explicit step limit and timeout.

## MCP in both directions

Muse consumes external MCP servers behind an allowlist, and `muse mcp serve` exposes read-only
grounded recall, search and user-model access to other agents.

---

## Repository layout

| Path | What lives there |
| --- | --- |
| `packages/agent-core` | The model-agnostic runtime: loops, guards, approvals, traces |
| `packages/model` | Provider adapters — the only place a vendor SDK is allowed |
| `packages/attunement`, `packages/attunement-graph` | Continuity threads and the MAG graph engine |
| `packages/recall`, `packages/memory`, `packages/stores` | Grounded recall, personal memory, file-backed stores |
| `packages/tools`, `packages/browser`, `packages/mcp` | Tool surface, browser control, MCP both ways |
| `apps/cli`, `apps/api`, `apps/web`, `apps/desktop` | The four surfaces, all on one runtime |
| `crates/runner` | Sandboxed local execution |
| `harness/` | The vendor-neutral agent operating harness used to build Muse |

39 workspace packages in total; [the system map](../product/SYSTEM-MAP.md) is the guided tour.

For the enforced rules behind these boundaries see
[`../../.claude/rules/engineering/architecture.md`](../../.claude/rules/engineering/architecture.md); for what each capability does,
see [the system map](../product/SYSTEM-MAP.md).
