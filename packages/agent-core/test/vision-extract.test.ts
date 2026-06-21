import type { JsonObject } from "@muse/shared";
import type { ModelProvider, ModelRequest, ModelResponse } from "@muse/model";
import { describe, expect, it } from "vitest";

import { describeImage, extractStructuredFromImage, validateExtraction } from "../src/vision-extract.js";

function stubProvider(output: string, capture?: (req: ModelRequest) => void): ModelProvider {
  return {
    generate: async (req: ModelRequest): Promise<ModelResponse> => {
      capture?.(req);
      return { id: "x", model: req.model, output };
    },
    id: "stub",
    listModels: async () => [],
    // eslint-disable-next-line require-yield
    stream: async function* () { throw new Error("unused"); }
  } as unknown as ModelProvider;
}

const SCHEMA = { properties: { merchant: { type: "string" }, total: { type: "number" } }, type: "object" } as const;
const input = (over = {}) => ({
  imageBase64: "QkFTRTY0",
  instruction: "Extract the merchant and total from this receipt.",
  mimeType: "image/png",
  model: "ollama/gemma4:12b",
  schema: SCHEMA,
  ...over
});

describe("extractStructuredFromImage", () => {
  it("parses a structured JSON object from the model output", async () => {
    const out = await extractStructuredFromImage(stubProvider('{"merchant":"Acme","total":12.5}'), input());
    expect(out.ok).toBe(true);
    expect(out.data).toEqual({ merchant: "Acme", total: 12.5 });
  });

  it("sends the image attachment, the schema as responseFormat, and temperature 0", async () => {
    let seen: ModelRequest | undefined;
    await extractStructuredFromImage(stubProvider("{}", (r) => { seen = r; }), input());
    expect(seen?.temperature).toBe(0);
    expect(seen?.responseFormat).toEqual(SCHEMA);
    const userMsg = seen?.messages.find((m) => m.role === "user");
    expect(userMsg?.attachments?.[0]).toEqual({ dataBase64: "QkFTRTY0", mimeType: "image/png" });
    // anti-fabrication instruction is present in the system message
    const sys = seen?.messages.find((m) => m.role === "system");
    expect(String(sys?.content)).toMatch(/never guess|OMIT it/u);
  });

  it("fail-soft on non-JSON output (no throw)", async () => {
    const out = await extractStructuredFromImage(stubProvider("I see a receipt from Acme."), input());
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/not valid JSON/u);
    expect(out.raw).toContain("Acme");
  });

  it("rejects a non-object JSON (array / scalar)", async () => {
    expect((await extractStructuredFromImage(stubProvider('["a","b"]'), input())).ok).toBe(false);
    expect((await extractStructuredFromImage(stubProvider('42'), input())).ok).toBe(false);
  });

  it("fail-soft when the provider throws", async () => {
    const throwing = { ...stubProvider("{}"), generate: async () => { throw new Error("ollama down"); } } as ModelProvider;
    const out = await extractStructuredFromImage(throwing, input());
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/ollama down/u);
  });

  // Schema-required validation: a hollow / partial extraction must fail CLOSED at
  // the source, not masquerade as ok:true and flow downstream (AppWorld no-partial-result).
  const RECEIPT_SCHEMA = { properties: { date: { type: "string" }, merchant: { type: "string" }, total: { type: "string" } }, required: ["merchant"], type: "object" } as const;

  it("fails closed when a required field is missing (hollow partial extraction)", async () => {
    const out = await extractStructuredFromImage(stubProvider('{"total":"5.00"}'), input({ schema: RECEIPT_SCHEMA }));
    expect(out.ok).toBe(false);
    expect(out.data).toBeUndefined();
    expect(out.error).toMatch(/required/u);
    expect(out.error).toMatch(/merchant/u);
  });

  it("passes a full extraction satisfying required (data echoes the object)", async () => {
    const out = await extractStructuredFromImage(stubProvider('{"merchant":"Acme","total":"5.00"}'), input({ schema: RECEIPT_SCHEMA }));
    expect(out.ok).toBe(true);
    expect(out.data).toEqual({ merchant: "Acme", total: "5.00" });
  });

  it("fails closed on an empty object {} when the schema declares a required field", async () => {
    const out = await extractStructuredFromImage(stubProvider("{}"), input({ schema: RECEIPT_SCHEMA }));
    expect(out.ok).toBe(false);
    expect(out.data).toBeUndefined();
    expect(out.error).toMatch(/merchant/u);
  });

  it("fails closed when a required field is present but empty / whitespace", async () => {
    const out = await extractStructuredFromImage(stubProvider('{"merchant":"   "}'), input({ schema: RECEIPT_SCHEMA }));
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/merchant/u);
  });

  it("fails closed when a required field has the wrong (non-string) type", async () => {
    const out = await extractStructuredFromImage(stubProvider('{"merchant":42}'), input({ schema: RECEIPT_SCHEMA }));
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/merchant/u);
  });

  it("back-compat: schema with NO required accepts an empty object", async () => {
    const out = await extractStructuredFromImage(stubProvider("{}"), input());
    expect(out.ok).toBe(true);
    expect(out.data).toEqual({});
  });
});

describe("validateExtraction — pure schema-required gate (no provider)", () => {
  const req = (...names: string[]) => ({ properties: {}, required: names, type: "object" }) as JsonObject;

  it("ok when every required field is a non-empty string", () => {
    expect(validateExtraction({ merchant: "Acme", total: "5.00" }, req("merchant"))).toEqual({ ok: true });
  });

  it("reports each missing required field", () => {
    const r = validateExtraction({ total: "5.00" }, req("merchant", "date"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing).toEqual(["merchant", "date"]);
  });

  it("a present-but-empty-string required field is a violation", () => {
    const r = validateExtraction({ merchant: "  " }, req("merchant"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing).toContain("merchant");
  });

  it("a required field of the wrong (non-string) type is a violation", () => {
    const r = validateExtraction({ merchant: 42 }, req("merchant"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing).toContain("merchant");
  });

  it("a string-typed PROPERTY (not required) whose value is non-string is a violation", () => {
    const schema = { properties: { total: { type: "string" } }, required: [], type: "object" } as JsonObject;
    const r = validateExtraction({ total: 5 }, schema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing).toContain("total");
  });

  it("back-compat: no schema → ok", () => {
    expect(validateExtraction({}, undefined)).toEqual({ ok: true });
  });

  it("back-compat: schema without `required` → ok even for {}", () => {
    expect(validateExtraction({}, { properties: { merchant: { type: "string" } }, type: "object" } as JsonObject)).toEqual({ ok: true });
  });

  it("back-compat: schema with empty required → ok for {}", () => {
    expect(validateExtraction({}, req())).toEqual({ ok: true });
  });
});

describe("describeImage — free-text screen/image description (fail-soft)", () => {
  const base = { imageBase64: "aW1n", mimeType: "image/png", model: "m" };

  it("returns the model's description text", async () => {
    const provider = stubProvider("A code editor with a failing test panel.");
    const result = await describeImage(provider, base);
    expect(result).toEqual({ ok: true, text: "A code editor with a failing test panel." });
  });

  it("passes the focusing question through and attaches the image", async () => {
    let seen: ModelRequest | undefined;
    const provider = stubProvider("The dialog says disk full.", (req) => { seen = req; });
    await describeImage(provider, { ...base, question: "what does the error dialog say?" });
    const user = seen?.messages.find((m) => m.role === "user");
    expect(user?.attachments).toEqual([{ dataBase64: "aW1n", mimeType: "image/png" }]);
    expect(user?.content).toContain("what does the error dialog say?");
  });

  it("a generate error returns ok:false instead of throwing", async () => {
    const provider = {
      generate: async () => { throw new Error("model offline"); },
      id: "boom",
      listModels: async () => [],
      // eslint-disable-next-line require-yield
      stream: async function* () { throw new Error("unused"); }
    } as unknown as ModelProvider;
    const result = await describeImage(provider, base);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("model offline");
  });

  it("an empty model output is ok:false (never a fabricated description)", async () => {
    const provider = stubProvider("   ");
    const result = await describeImage(provider, base);
    expect(result.ok).toBe(false);
  });
});
