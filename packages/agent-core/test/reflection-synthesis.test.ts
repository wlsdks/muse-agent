import type { ModelRequest } from "@muse/model";
import { describe, expect, it } from "vitest";

import {
  buildReflectionUserMessage,
  parseReflections,
  synthesizeReflections,
  type ReflectionInput
} from "../src/reflection-synthesis.js";

const ids = (...xs: string[]): ReadonlySet<string> => new Set(xs);

describe("buildReflectionUserMessage — renders an [id] text list for the model", () => {
  it("prefixes each item with its id and collapses internal whitespace", () => {
    const out = buildReflectionUserMessage([
      { id: "ep-1", text: "  ran   5km   before\nwork  " },
      { id: "note-2", text: "prefers tea" }
    ]);
    expect(out).toBe("Recent items:\n[ep-1] ran 5km before work\n[note-2] prefers tea");
  });

  it("redacts secrets in item text before the model ever sees them (default redactor)", () => {
    // Reflection runs over the user's own raw notes; a leaked key in a note
    // must not be echoed back into the reflection prompt.
    const out = buildReflectionUserMessage([{ id: "n", text: "my key is sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa" }]);
    expect(out).not.toContain("sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(out).toContain("[redacted-anthropic-key]");
  });

  it("honours a custom redactor and yields just the header for an empty input list", () => {
    expect(buildReflectionUserMessage([{ id: "x", text: "SECRET" }], () => "MASKED")).toBe("Recent items:\n[x] MASKED");
    expect(buildReflectionUserMessage([])).toBe("Recent items:\n");
  });
});

describe("parseReflections — the grounding / citation honesty gate (WEDGE)", () => {
  it("keeps a well-grounded reflection, trimming the insight and reporting supportCount", () => {
    const out = parseReflections(
      JSON.stringify([{ insight: "  Runs regularly in the mornings.  ", sources: ["a", "b"] }]),
      ids("a", "b", "c")
    );
    expect(out).toEqual([{ insight: "Runs regularly in the mornings.", sourceIds: ["a", "b"], supportCount: 2 }]);
  });

  it("STRIPS an invented source id the user does not actually have (no confabulated grounding)", () => {
    // The model cited a real pair plus a hallucinated id; the fake id is removed
    // and — since the two real ids still meet minSupport — the insight survives
    // grounded ONLY in the real sources.
    const out = parseReflections(
      JSON.stringify([{ insight: "Focused on the Q3 launch.", sources: ["a", "GHOST", "b"] }]),
      ids("a", "b")
    );
    expect(out).toHaveLength(1);
    expect(out[0].sourceIds).toEqual(["a", "b"]);
    expect(out[0].supportCount).toBe(2);
  });

  it("DROPS a reflection that falls below minSupport once invented sources are stripped", () => {
    // Only one cited id is real → under-supported → dropped entirely rather than
    // surfaced as a weakly-grounded (fabrication-risk) insight.
    const out = parseReflections(
      JSON.stringify([{ insight: "Loves sailing.", sources: ["real", "FAKE1", "FAKE2"] }]),
      ids("real")
    );
    expect(out).toEqual([]);
  });

  it("dedupes repeated source ids before counting support", () => {
    // Three citations but only one distinct real id → supportCount 1 < default 2 → dropped.
    expect(
      parseReflections(JSON.stringify([{ insight: "x", sources: ["a", "a", "a"] }]), ids("a", "b"))
    ).toEqual([]);
    // Two distinct after dedup → survives with supportCount 2.
    const ok = parseReflections(JSON.stringify([{ insight: "y", sources: ["a", "b", "a"] }]), ids("a", "b"));
    expect(ok[0]?.supportCount).toBe(2);
  });

  it("honours minSupport=1 (a single real source is enough when configured)", () => {
    const out = parseReflections(JSON.stringify([{ insight: "z", sources: ["a"] }]), ids("a"), { minSupport: 1 });
    expect(out).toHaveLength(1);
    expect(out[0].supportCount).toBe(1);
  });

  it("skips malformed entries: empty/blank insight, non-string insight, non-array sources, non-object", () => {
    const raw = JSON.stringify([
      { insight: "   ", sources: ["a", "b"] },
      { insight: 42, sources: ["a", "b"] },
      { insight: "no sources field" },
      { insight: "string sources", sources: "a,b" },
      "not-an-object",
      null,
      { insight: "valid one", sources: ["a", "b"] }
    ]);
    const out = parseReflections(raw, ids("a", "b"));
    expect(out.map((r) => r.insight)).toEqual(["valid one"]);
  });

  it("filters non-string entries inside the sources array (never coerces a number to an id)", () => {
    const out = parseReflections(
      JSON.stringify([{ insight: "mixed sources", sources: ["a", 7, true, "b", null] }]),
      ids("a", "b", "7")
    );
    expect(out[0]?.sourceIds).toEqual(["a", "b"]);
  });

  it("caps the result at maxReflections, keeping the first survivors in order", () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({ insight: `insight ${i}`, sources: ["a", "b"] }));
    const out = parseReflections(JSON.stringify(entries), ids("a", "b"), { maxReflections: 2 });
    expect(out.map((r) => r.insight)).toEqual(["insight 0", "insight 1"]);
  });

  it("coerces a non-positive / fractional maxReflections or minSupport to a sane floor of 1", () => {
    const entries = JSON.stringify([{ insight: "only", sources: ["a"] }]);
    // maxReflections 0 → floored to 1 (still returns the one survivor), minSupport 0 → floored to 1.
    const out = parseReflections(entries, ids("a"), { maxReflections: 0, minSupport: 0 });
    expect(out).toHaveLength(1);
    // fractional values are truncated, not rounded up.
    expect(parseReflections(entries, ids("a"), { minSupport: 1.9 })).toHaveLength(1);
  });

  it("returns [] for prose-only output, invalid JSON, and a non-array JSON value", () => {
    expect(parseReflections("I could not find any recurring themes.", ids("a", "b"))).toEqual([]);
    expect(parseReflections("[ {bad json", ids("a", "b"))).toEqual([]);
    expect(parseReflections(JSON.stringify({ insight: "obj not array", sources: ["a", "b"] }), ids("a", "b"))).toEqual([]);
  });

  it("extracts the JSON array even when the model wraps it in prose", () => {
    const out = parseReflections(
      'Here are my reflections: [{"insight":"reads daily","sources":["a","b"]}] — hope that helps!',
      ids("a", "b")
    );
    expect(out).toHaveLength(1);
    expect(out[0].insight).toBe("reads daily");
  });
});

function fakeProvider(output: string, sink?: { request?: ModelRequest }) {
  return {
    generate: async (request: ModelRequest) => {
      if (sink) sink.request = request;
      return { id: "r", model: request.model, output };
    }
  };
}

describe("synthesizeReflections — thin model wrapper, fail-soft + grounded", () => {
  const two: ReflectionInput[] = [
    { id: "a", text: "ran 5km" },
    { id: "b", text: "ran again at dawn" }
  ];

  it("returns [] WITHOUT calling the model when fewer than minSupport usable items exist", async () => {
    let called = false;
    const provider = { generate: async (r: ModelRequest) => { called = true; return { id: "r", model: r.model, output: "[]" }; } };
    const out = await synthesizeReflections([{ id: "a", text: "lonely" }], { model: "m", modelProvider: provider });
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });

  it("drops items with a blank id or blank text before counting usable support", async () => {
    let called = false;
    const provider = { generate: async (r: ModelRequest) => { called = true; return { id: "r", model: r.model, output: "[]" }; } };
    // one real + one blank-text + one blank-id = 1 usable < minSupport 2 → no model call.
    const out = await synthesizeReflections(
      [{ id: "a", text: "real" }, { id: "b", text: "   " }, { id: "", text: "orphan" }],
      { model: "m", modelProvider: provider }
    );
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });

  it("grounds the model output against ONLY the usable input ids and applies defaults", async () => {
    const sink: { request?: ModelRequest } = {};
    const provider = fakeProvider(
      JSON.stringify([{ insight: "Runs every morning.", sources: ["a", "b", "INVENTED"] }]),
      sink
    );
    const out = await synthesizeReflections(two, { model: "qwen", modelProvider: provider });
    expect(out).toEqual([{ insight: "Runs every morning.", sourceIds: ["a", "b"], supportCount: 2 }]);
    expect(sink.request?.temperature).toBe(0.4);
    expect(sink.request?.maxOutputTokens).toBe(400);
    expect(sink.request?.model).toBe("qwen");
  });

  it("forwards explicit temperature / maxOutputTokens overrides to the request", async () => {
    const sink: { request?: ModelRequest } = {};
    await synthesizeReflections(two, {
      model: "m",
      modelProvider: fakeProvider("[]", sink),
      temperature: 0,
      maxOutputTokens: 128
    });
    expect(sink.request?.temperature).toBe(0);
    expect(sink.request?.maxOutputTokens).toBe(128);
  });

  it("uses a custom redact over the inputs (not the default) when one is supplied", async () => {
    const sink: { request?: ModelRequest } = {};
    await synthesizeReflections(two, {
      model: "m",
      modelProvider: fakeProvider("[]", sink),
      redact: (t) => `XX${t}XX`
    });
    const userMsg = sink.request?.messages.find((m) => m.role === "user")?.content ?? "";
    expect(userMsg).toContain("[a] XXran 5kmXX");
  });

  it("forwards maxReflections to the grounding cap (not just the default 5)", async () => {
    const provider = fakeProvider(
      JSON.stringify([
        { insight: "one", sources: ["a", "b"] },
        { insight: "two", sources: ["a", "b"] },
        { insight: "three", sources: ["a", "b"] }
      ])
    );
    const out = await synthesizeReflections(two, { model: "m", modelProvider: provider, maxReflections: 1 });
    expect(out.map((r) => r.insight)).toEqual(["one"]);
  });

  it("fail-soft: a throwing model provider yields [] (reflection never blocks)", async () => {
    const provider = { generate: async () => { throw new Error("model down"); } };
    expect(await synthesizeReflections(two, { model: "m", modelProvider: provider })).toEqual([]);
  });
});
