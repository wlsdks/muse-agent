import type { ModelMessage, ModelProvider, ModelRequest, ModelResponse } from "@muse/model";
import { describe, expect, it, vi } from "vitest";

import { buildReferenceBlock, moaFanout, type MoaSlot } from "../src/moa-fanout.js";

const resp = (output: string, extra: Partial<ModelResponse> = {}): ModelResponse => ({
  id: "r",
  model: "m",
  output,
  ...extra,
});

/** A provider whose `generate` returns a fixed output and records its request. */
function fixedProvider(output: string, extra: Partial<ModelResponse> = {}) {
  const calls: ModelRequest[] = [];
  const provider: Pick<ModelProvider, "generate"> = {
    generate: async (request) => {
      calls.push(request);
      return resp(output, extra);
    },
  };
  return { provider, calls };
}

const question: readonly ModelMessage[] = [
  { role: "system", content: "You are Muse." },
  { role: "user", content: "How should I structure a monorepo?" },
];

const acting = (): { slot: MoaSlot; calls: ModelRequest[] } => {
  const { provider, calls } = fixedProvider("FINAL ANSWER");
  return { slot: { provider, model: "acting-model" }, calls };
};

describe("moaFanout — advisory fan-out (DS-15)", () => {
  it("2 references + 1 acting all succeed → acting prompt contains the appended block with BOTH reference outputs", async () => {
    const refA = fixedProvider("perspective from A");
    const refB = fixedProvider("perspective from B");
    const act = acting();

    const result = await moaFanout({
      messages: question,
      references: [
        { provider: refA.provider, model: "gemma", label: "gemma" },
        { provider: refB.provider, model: "qwen", label: "qwen" },
      ],
      acting: act.slot,
    });

    expect(result.response.output).toBe("FINAL ANSWER");
    expect(result.referenceBlockAppended).toBe(true);

    const actingReq = act.calls[0]!;
    const appended = actingReq.messages[actingReq.messages.length - 1]!;
    expect(appended.role).toBe("system");
    expect(appended.content).toContain("perspective from A");
    expect(appended.content).toContain("perspective from B");
    expect(appended.content).toContain("[gemma]");
    expect(appended.content).toContain("[qwen]");
  });

  it("PREFIX is byte-identical to the original messages (prompt-cache friendliness)", async () => {
    const refA = fixedProvider("A");
    const act = acting();

    const result = await moaFanout({
      messages: question,
      references: [{ provider: refA.provider, model: "gemma" }],
      acting: act.slot,
    });

    const actingReq = act.calls[0]!;
    // acting messages = original prefix + exactly one appended system block
    expect(actingReq.messages).toHaveLength(question.length + 1);
    const prefix = actingReq.messages.slice(0, question.length);
    expect(prefix).toEqual(question);
    // and each reference call saw the ORIGINAL messages, byte-identical to the prefix
    expect(refA.calls[0]!.messages).toEqual(question);
    // result echoes the exact acting messages
    expect(result.actingMessages).toBe(actingReq.messages);
  });

  it("one reference REJECTS → the other reference's output still reaches the acting model; failure does not propagate", async () => {
    const good = fixedProvider("good advice");
    const bad: Pick<ModelProvider, "generate"> = {
      generate: async () => {
        throw new Error("advisor exploded");
      },
    };
    const act = acting();

    const result = await moaFanout({
      messages: question,
      references: [
        { provider: bad, model: "broken" },
        { provider: good.provider, model: "gemma", label: "gemma" },
      ],
      acting: act.slot,
    });

    expect(result.response.output).toBe("FINAL ANSWER");
    expect(result.referenceBlockAppended).toBe(true);
    expect(result.references[0]!.ok).toBe(false);
    expect(result.references[0]!.error).toBeInstanceOf(Error);
    expect(result.references[1]!.ok).toBe(true);

    const appended = act.calls[0]!.messages.at(-1)!;
    expect(appended.content).toContain("good advice");
    expect(appended.content).not.toContain("broken");
  });

  it("ALL references fail → falls back to calling the acting model with just the original messages (no empty block)", async () => {
    const bad: Pick<ModelProvider, "generate"> = {
      generate: async () => {
        throw new Error("nope");
      },
    };
    const act = acting();

    const result = await moaFanout({
      messages: question,
      references: [
        { provider: bad, model: "b1" },
        { provider: bad, model: "b2" },
      ],
      acting: act.slot,
    });

    expect(result.response.output).toBe("FINAL ANSWER");
    expect(result.referenceBlockAppended).toBe(false);
    // acting saw the ORIGINAL messages, unchanged — no appended reference block
    expect(act.calls[0]!.messages).toEqual(question);
    expect(result.actingMessages).toBe(question);
    expect(result.references.every((r) => !r.ok)).toBe(true);
  });

  it("empty references list → plain single-model answer, no block", async () => {
    const act = acting();
    const result = await moaFanout({ messages: question, references: [], acting: act.slot });
    expect(result.referenceBlockAppended).toBe(false);
    expect(act.calls[0]!.messages).toEqual(question);
  });

  it("a reference that returns only whitespace is not treated as usable", async () => {
    const blank = fixedProvider("   \n  ");
    const act = acting();
    const result = await moaFanout({
      messages: question,
      references: [{ provider: blank.provider, model: "blank" }],
      acting: act.slot,
    });
    expect(result.referenceBlockAppended).toBe(false);
    expect(act.calls[0]!.messages).toEqual(question);
  });

  it("reference calls carry NO tools field and reasoning:false", async () => {
    const refA = fixedProvider("A");
    const act = acting();
    await moaFanout({
      messages: question,
      references: [{ provider: refA.provider, model: "gemma" }],
      acting: act.slot,
    });
    const refReq = refA.calls[0]!;
    expect(refReq.tools).toBeUndefined();
    expect(refReq.reasoning).toBe(false);
  });

  it("threads signal / temperature / maxOutputTokens into every reference AND the acting call", async () => {
    const refA = fixedProvider("A");
    const act = acting();
    const controller = new AbortController();
    await moaFanout({
      messages: question,
      references: [{ provider: refA.provider, model: "gemma" }],
      acting: act.slot,
      signal: controller.signal,
      temperature: 0.3,
      maxOutputTokens: 256,
    });
    for (const req of [refA.calls[0]!, act.calls[0]!]) {
      expect(req.signal).toBe(controller.signal);
      expect(req.temperature).toBe(0.3);
      expect(req.maxOutputTokens).toBe(256);
    }
  });

  it("acting call runs with actingReasoning when requested; references stay reasoning:false", async () => {
    const refA = fixedProvider("A");
    const act = acting();
    await moaFanout({
      messages: question,
      references: [{ provider: refA.provider, model: "gemma" }],
      acting: act.slot,
      actingReasoning: true,
    });
    expect(refA.calls[0]!.reasoning).toBe(false);
    expect(act.calls[0]!.reasoning).toBe(true);
  });

  it("attributes usage per reference slot AND the acting call (each to its own model)", async () => {
    const refA = fixedProvider("A", { usage: { inputTokens: 10, outputTokens: 5 } });
    const failing: Pick<ModelProvider, "generate"> = {
      generate: async () => {
        throw new Error("down");
      },
    };
    const { provider: actProv, calls: actCalls } = fixedProvider("FINAL", { usage: { inputTokens: 40, outputTokens: 20 } });

    const refUsage = vi.fn();
    const actUsage = vi.fn();
    await moaFanout({
      messages: question,
      references: [
        { provider: refA.provider, model: "gemma", label: "gemma" },
        { provider: failing, model: "qwen" },
      ],
      acting: { provider: actProv, model: "acting-model" },
      onReferenceUsage: refUsage,
      onActingUsage: actUsage,
    });

    expect(actCalls).toHaveLength(1);
    // both reference slots reported — the succeeding one carries usage, the failing one does not
    expect(refUsage).toHaveBeenCalledTimes(2);
    expect(refUsage).toHaveBeenCalledWith({ index: 0, label: "gemma", model: "gemma", usage: { inputTokens: 10, outputTokens: 5 } });
    expect(refUsage).toHaveBeenCalledWith({ index: 1, label: "Advisor B", model: "qwen" });
    // acting usage attributed to its OWN model, not folded into a reference count
    expect(actUsage).toHaveBeenCalledTimes(1);
    expect(actUsage).toHaveBeenCalledWith({ model: "acting-model", usage: { inputTokens: 40, outputTokens: 20 } });
  });

  it("fires reference calls CONCURRENTLY, not sequentially (wall-clock ≈ max delay, not sum)", async () => {
    const slow = (ms: number): Pick<ModelProvider, "generate"> => ({
      generate: async () => {
        await new Promise((r) => setTimeout(r, ms));
        return resp(`slept ${ms}`);
      },
    });
    const act = acting();
    const started = Date.now();
    await moaFanout({
      messages: question,
      references: [
        { provider: slow(60), model: "a" },
        { provider: slow(60), model: "b" },
        { provider: slow(60), model: "c" },
      ],
      acting: act.slot,
    });
    const elapsed = Date.now() - started;
    // Concurrent ⇒ ~60ms. A sequential `for … await` regression makes this ~180ms → RED.
    expect(elapsed).toBeLessThan(150);
  });

  it("buildReferenceBlock is pure and labels each perspective", () => {
    const block = buildReferenceBlock([
      { label: "gemma", output: "  use pnpm  " },
      { label: "qwen", output: "use turborepo" },
    ]);
    expect(block).toContain("[gemma]:\nuse pnpm");
    expect(block).toContain("[qwen]:\nuse turborepo");
    expect(block.indexOf("[gemma]")).toBeLessThan(block.indexOf("[qwen]"));
  });
});
