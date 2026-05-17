# 289 — one throwing subscriber broke agent-message-bus delivery to all the others

## Why

`InMemoryAgentMessageBus` is the cross-agent fan-out primitive
for `MultiAgentOrchestrator` / `SupervisorAgent` and the
SSE-stream consumers wired in goals 271/272.
`notifySubscribers` invoked every handler with:

```ts
await Promise.all(handlers.map((handler) => handler(message)));
```

No per-handler isolation. Two failure modes:

- A handler that throws **synchronously** (the common bug shape —
  a guard, a `JSON.parse`, a null deref before the first `await`)
  throws *inside the `.map` callback*, so the `.map` itself
  throws **before `Promise.all` is even constructed**. Every
  handler ordered after the thrower in the bucket / iteration is
  **never invoked**, and `publish()` rejects.
- An async handler that rejects makes `Promise.all` reject, so
  `publish()` rejects even though the other handlers ran.

So a single misbehaving agent subscriber silently drops the
message to every other agent and fails the publisher. Goal 262
isolated publish failures at two `MultiAgentOrchestrator` call
sites with `.catch()`, but the **bus itself** still propagated —
every other caller (supervisor, the agent-notice / multi-agent
SSE streams) was unprotected. A shared message bus is fail-open
infrastructure (CLAUDE.md: guards fail-close, hooks/infra
fail-open); subscriber callbacks are hook-like and must be
isolated at the bus.

## Scope

`packages/multi-agent/src/agent-message-bus.ts`:

- Route every handler invocation (targeted **and** broadcast)
  through a private `deliver(handler, message)` that
  `try { await handler(message) } catch { /* swallow */ }`. The
  `async` wrapper turns a synchronous subscriber throw into a
  caught rejection of the wrapper, so `.map` never throws and
  `Promise.all` always resolves — best-effort fan-out. One short
  WHY comment records the fail-open rationale.

Behaviour-preserving for well-behaved subscribers: ordering,
targeted-vs-broadcast routing, `await`-all-before-publish-resolves
semantics, and the message log are unchanged — only a
throwing/rejecting subscriber is now contained instead of
poisoning the fan-out.

## Verify

- `pnpm --filter @muse/multi-agent test` — 46 pass. New
  regression: a bucket whose **first** subscriber throws
  synchronously plus a later same-bucket sibling and another
  agent with a rejecting-async handler + a good handler — after a
  broadcast `publish()` (resolves, not rejects) every good
  handler still ran exactly once; a subsequent targeted publish
  into the throwing bucket also still delivers to the sibling.
  Existing targeted / broadcast / getMessages / getConversation /
  clear / eviction / orchestrator-with-bus tests stay green.
- `pnpm check` — every workspace green (multi-agent 46,
  apps/cli 561, apps/api 160, all packages). `pnpm lint` —
  exit 0.
- No real-LLM request/response path touched (in-memory bus
  fan-out control flow; synthetic handlers, no model round-trip).
  A live Qwen run cannot reproduce a mid-fan-out subscriber throw
  on demand, so the deterministic regression is the rigorous
  verification — same stance as the isolation goal 262 and
  261 / 274–288.

## Status

done — the agent message bus now isolates each subscriber, so a
single throwing or rejecting handler can no longer silently drop
the message to every other agent or reject the publisher.
Generalises goal 262's per-call-site isolation down to the bus so
all callers (supervisor, both SSE streams) benefit. Well-behaved
delivery is unchanged.
