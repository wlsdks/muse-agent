import type { ModelProvider, ModelRequest, ModelResponse, ModelToolCall } from "@muse/model";
import { describe, expect, it } from "vitest";

import { executeModelLoop, type ModelLoopRunner } from "../src/model-loop.js";
import type { ExecutedToolResult } from "../src/runtime-internals.js";
import type { AgentRunContext } from "../src/types.js";

// Phase-scoped tool discipline (eval:multifile-fix RED probe): when a general
// shell (run_command) is exposed alongside the structured file tools, the small
// model "reads" via the shell (cat/ls/find) and never lands a file_edit. The
// gate withholds run_command during the fix phase and re-arms it after a write
// lands. This test asserts the WIRING: which tools the loop offers each turn.

const provider = {} as unknown as ModelProvider;
const runCommand = { name: "run_command", description: "run", inputSchema: { type: "object" as const }, risk: "execute" as const };
const fileRead = { name: "file_read", description: "read", inputSchema: { type: "object" as const }, risk: "read" as const };
const fileEdit = { name: "file_edit", description: "edit", inputSchema: { type: "object" as const }, risk: "write" as const };

const context = (): AgentRunContext => ({
  runId: "run-shell-phase",
  startedAt: new Date("2026-01-01T00:00:00Z"),
  input: { model: "m", messages: [{ role: "user", content: "fix the failing test" }] }
});

// Drives a FIXED trajectory mirroring the observed failure → fix path, and
// records the tool names OFFERED each turn (req.tools) so the test can assert
// the gate's per-turn withholding. `script[turn]` is the tool the model calls;
// a turn past the script returns a final synthesis.
function scriptedRunner(opts: {
  tools: readonly { name: string }[];
  script: readonly string[];
  offered: string[][];
}): ModelLoopRunner {
  let turn = 0;
  return {
    maxToolCalls: 20,
    generateWithTracing: async (_ctx: AgentRunContext, _p: ModelProvider, req: ModelRequest): Promise<ModelResponse> => {
      opts.offered.push((req.tools ?? []).map((t) => t.name));
      const want = opts.script[turn];
      turn += 1;
      if (!want || (req.tools?.length ?? 0) === 0) {
        return { id: "fin", model: "m", output: "done", toolCalls: [] };
      }
      const call: ModelToolCall = { id: `t${turn.toString()}`, name: want, arguments: {} };
      return { id: `x${turn.toString()}`, model: "m", output: "working", toolCalls: [call] };
    },
    executeToolCall: async (_ctx, toolCall): Promise<ExecutedToolResult> => {
      const output = toolCall.name === "file_edit"
        ? JSON.stringify({ edits: 1, path: "/tmp/math.mjs", written: true })
        : toolCall.name === "run_command"
          ? "TEST FAIL: multiply(3,4) returned 7"
          : "export function multiply(a,b){return a+b;}";
      return { result: { id: toolCall.id, name: toolCall.name, output, status: "completed" }, toolCall };
    }
  } as unknown as ModelLoopRunner;
}

describe("executeModelLoop — general-shell phase gate (eval:multifile-fix)", () => {
  it("withholds run_command during the fix phase, keeps the file tools, then re-arms after a landed write", async () => {
    const offered: string[][] = [];
    await executeModelLoop(
      scriptedRunner({
        tools: [runCommand, fileRead, fileEdit],
        // run test → (try to inspect) → read → edit(lands) → run test (confirm) → done
        script: ["run_command", "file_read", "file_edit", "run_command"],
        offered
      }),
      context(),
      provider,
      { model: "m", messages: [{ role: "user", content: "fix it" }], tools: [runCommand, fileRead, fileEdit] }
    );

    // Turn 1: shell available (run the failing test to SEE the error).
    expect(offered[0]).toContain("run_command");
    // Turn 2: shell WITHHELD (fix phase), file tools still offered.
    expect(offered[1]).not.toContain("run_command");
    expect(offered[1]).toEqual(expect.arrayContaining(["file_read", "file_edit"]));
    // Turn 3: still withheld — a read did not re-arm it (only a landed write does).
    expect(offered[2]).not.toContain("run_command");
    // Turn 4: RE-ARMED after the file_edit landed (confirm the fix).
    expect(offered[3]).toContain("run_command");
  });

  it("never withholds the shell when no structured file-write tool is exposed (the execute eval / one-file loop does not regress)", async () => {
    const offered: string[][] = [];
    await executeModelLoop(
      scriptedRunner({
        tools: [runCommand, fileRead],
        script: ["run_command", "run_command", "run_command"],
        offered
      }),
      context(),
      provider,
      { model: "m", messages: [{ role: "user", content: "run it" }], tools: [runCommand, fileRead] }
    );
    // run_command stays offered every turn — the gate never engaged.
    for (const turnTools of offered) {
      expect(turnTools).toContain("run_command");
    }
  });
});
