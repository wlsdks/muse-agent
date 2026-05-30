import { describe, expect, it } from "vitest";

import {
  buildReflectionUserMessage,
  parseReflections,
  synthesizeReflections,
  type ReflectionInput
} from "./reflection-synthesis.js";

const ids = new Set(["e1", "e2", "e3"]);

describe("buildReflectionUserMessage", () => {
  it("labels each item with its [id] and collapses whitespace", () => {
    const msg = buildReflectionUserMessage([{ id: "e1", text: "fixed the\n\n VPN" }], (t) => t);
    expect(msg).toContain("[e1] fixed the VPN");
  });
});

describe("parseReflections — grounding / honesty guard", () => {
  it("keeps a well-grounded reflection with its distinct real sources", () => {
    const out = parseReflections(
      '[{"insight":"You keep wrestling with home networking","sources":["e1","e2"]}]',
      ids
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ insight: "You keep wrestling with home networking", sourceIds: ["e1", "e2"], supportCount: 2 });
  });

  it("STRIPS invented source ids the user doesn't actually have", () => {
    const out = parseReflections(
      '[{"insight":"x","sources":["e1","e2","e99-made-up"]}]',
      ids
    );
    expect(out[0]!.sourceIds).toEqual(["e1", "e2"]); // e99 dropped
    expect(out[0]!.supportCount).toBe(2);
  });

  it("drops a reflection that falls below minSupport after grounding", () => {
    // Only e1 is real → 1 source < default minSupport 2 → dropped.
    expect(parseReflections('[{"insight":"x","sources":["e1","ghost"]}]', ids)).toEqual([]);
  });

  it("dedupes repeated source ids before counting support", () => {
    expect(parseReflections('[{"insight":"x","sources":["e1","e1","e1"]}]', ids)).toEqual([]); // 1 distinct < 2
  });

  it("drops empty insights and non-array sources; tolerates junk around the JSON", () => {
    const out = parseReflections(
      'sure! here:\n[{"insight":"  ","sources":["e1","e2"]},{"insight":"good","sources":["e1","e2","e3"]},{"insight":"bad","sources":"e1"}]\nhope that helps',
      ids
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.insight).toBe("good");
  });

  it("returns [] on non-JSON / non-array / parse errors", () => {
    expect(parseReflections("I have no reflections.", ids)).toEqual([]);
    expect(parseReflections('{"insight":"x"}', ids)).toEqual([]);
    expect(parseReflections("[not, valid, json", ids)).toEqual([]);
  });

  it("caps the result to maxReflections", () => {
    const raw = JSON.stringify(Array.from({ length: 6 }, () => ({ insight: "x", sources: ["e1", "e2"] })));
    expect(parseReflections(raw, ids, { maxReflections: 3 })).toHaveLength(3);
  });
});

describe("synthesizeReflections — model-driven", () => {
  const inputs: ReflectionInput[] = [
    { id: "e1", text: "Fixed the office VPN handshake by setting MTU 1380." },
    { id: "e2", text: "Wireguard kept dropping; tuned the MTU again." },
    { id: "e3", text: "Booked a dentist appointment." }
  ];

  it("returns [] without calling the model when there are too few items to reflect", async () => {
    let called = false;
    const out = await synthesizeReflections([inputs[0]!], {
      model: "m",
      modelProvider: { generate: async () => { called = true; return { output: "[]" }; } } as never
    });
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });

  it("grounds the model's output (strips invented ids, applies minSupport)", async () => {
    const out = await synthesizeReflections(inputs, {
      model: "m",
      modelProvider: {
        generate: async () => ({ output: '[{"insight":"Recurring home-network/VPN troubleshooting","sources":["e1","e2","e404"]}]' })
      } as never
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.sourceIds).toEqual(["e1", "e2"]); // e404 invented → stripped
  });

  it("fail-soft: a thrown model call yields []", async () => {
    const out = await synthesizeReflections(inputs, {
      model: "m",
      modelProvider: { generate: async () => { throw new Error("model down"); } } as never
    });
    expect(out).toEqual([]);
  });
});
