---
title: Hooks — PreToolUse / PostToolUse
audience: [developers, AI agents]
purpose: The canonical harness layer that intercepts tool calls before/after execution to block them un-bypassably or observe them
updated: 2026-06-13
---

# Hooks

One of the canonical harness's five layers (memory · tools · permissions · **hooks** ·
observability). The 2026 consensus (Boris Cherny / Claude Code) is **"start with memory + hooks"**
— because these two prevent the most common failures. The key point: **a PreToolUse hook is the
only mechanism that can block a tool call *unconditionally*, and it cannot be bypassed.**

## What it is

- **PreToolUse** — runs *before* the tool executes. If any hook rejects (or throws), the call is
  **blocked** and no actual execution happens (fail-closed).
- **PostToolUse** — runs *after* the tool executes. For observation (logging, tracing); throwing
  does not block or corrupt the result.

## Why it is separate from the gates

The permission gate ([permission-matrix](../core/permission-matrix.md)) is the rule that judges
"is this tier allowed"; hooks are the **execution mechanism that inserts those rules into the path
of every tool call**. So in our code the **permission gate ships as the default PreToolUse hook**
(`permissionHook`) — permission enforcement = one instance of a hook.

## How to use it (code)

[runner/hooks.mjs](../runner/hooks.mjs) (zero dependencies):

- `createHookPipeline()` → `onPreToolUse(fn)` · `onPostToolUse(fn)`
- `dispatchTool(pipeline, call, execute)` — **the only sanctioned path a tool runs through**. If a
  pre-hook blocks, `execute()` is never reached, so enforcement cannot be skipped.
- `permissionHook` — the built-in that uses the permission gate as a PreToolUse hook.

```
const p = createHookPipeline();
p.onPreToolUse(permissionHook);            // banking=refused, outbound=requires confirmed + resolved
p.onPostToolUse((call, res) => trace(call, res));
const r = await dispatchTool(p, { kind: 'outbound', recipientResolved: true, confirmed: true }, send);
// pre-hook passes → send executes → post-hook observes. If blocked: r.blocked=true, send never runs.
```

## Verification

[runner/hooks.test.mjs](../runner/hooks.test.mjs) — `node --test "harness/runner/*.test.mjs"`:
PreToolUse rejection blocks execution · on pass, execution + PostToolUse observation · a hook
exception blocks fail-closed · with multiple hooks the first rejection wins · the permission hook
(banking/outbound blocked, read allowed) · a PostToolUse exception leaves the result unchanged.
**6/6.**

## Limits / next

This takes effect only when the host wraps its own tool dispatch in `dispatchTool` (what we
enforce is "once wrapped, there is no escape"). Automatic hooking when using an agent CLI directly
is the host runtime's job. (Observability, session persistence, memory, and tools are all also
filled in as code later — [architecture §4](architecture.md).)
