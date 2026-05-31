// PreToolUse / PostToolUse hooks — the non-bypassable enforcement point around
// every tool call. Per the 2026 harness consensus (Boris Cherny / Claude Code),
// a PreToolUse hook is the one mechanism that can UNCONDITIONALLY block a tool
// call; hooks cannot be bypassed. Fail-closed: any PreToolUse hook that denies
// OR throws blocks the call. PostToolUse hooks are observational and never
// resurrect a blocked call or fail a successful one.
//
// This is harness infrastructure (it runs), not the domain work. Zero deps.

import { permissionGate } from './harness-runner.mjs';

export function createHookPipeline() {
  const pre = [];
  const post = [];
  return {
    onPreToolUse(fn) { pre.push(fn); return this; },
    onPostToolUse(fn) { post.push(fn); return this; },

    // Returns {allow:true} or {allow:false, reason, by}. First deny wins.
    async runPre(call) {
      for (const fn of pre) {
        let res;
        try {
          res = await fn(call);
        } catch (e) {
          return { allow: false, reason: `hook threw: ${e.message}`, by: fn.name || 'preHook' };
        }
        if (res && res.allow === false) {
          return { allow: false, reason: res.reason || 'denied', by: fn.name || 'preHook' };
        }
      }
      return { allow: true };
    },

    // Observational: collect hook outputs; a throwing post hook is swallowed so
    // it can neither block nor corrupt the already-produced result.
    async runPost(call, result) {
      const observations = [];
      for (const fn of post) {
        try { observations.push(await fn(call, result)); } catch { /* observational */ }
      }
      return observations;
    },
  };
}

// Built-in PreToolUse hook: the permission gate. Reuses the single source of
// truth in harness-runner.mjs so permission enforcement IS a hook.
export function permissionHook(call) {
  const g = permissionGate(call);
  return { allow: g.ok, reason: g.reason };
}

// Guarded dispatcher: pre-hooks (fail-closed) -> execute -> post-hooks. The
// only sanctioned way to run a tool — execute() is never reached if a pre-hook
// blocks, so enforcement cannot be skipped.
export async function dispatchTool(pipeline, call, execute) {
  const pre = await pipeline.runPre(call);
  if (!pre.allow) return { ok: false, blocked: true, reason: pre.reason, by: pre.by };
  const result = await execute(call);
  const observations = await pipeline.runPost(call, result);
  return { ok: true, result, observations };
}
