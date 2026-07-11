import { describe, expect, it } from "vitest";

import { parseOpenAIStream } from "../src/provider-openai.js";
import { parseOpenAIResponsesStream } from "../src/provider-openai-responses.js";
import type { ModelEvent } from "../src/index.js";

const enc = new TextEncoder();
function streamOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
      else controller.close();
    }
  });
}
async function collect(gen: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const event of gen) out.push(event);
  return out;
}
const textOf = (events: ModelEvent[]) =>
  events.filter((e): e is Extract<ModelEvent, { type: "text-delta" }> => e.type === "text-delta")
    .map((e) => e.text).join("");
const data = (o: unknown) => `data: ${JSON.stringify(o)}`;

// A compliant server ends with `[DONE]\n\n`, so the last real event always
// has a trailing blank line. But OpenAI-compatible local backends (LM Studio,
// llama.cpp, custom) may close the stream right after the final event with no
// trailing `\n\n` — and that final delta / tool-call was being dropped.
describe("OpenAI SSE parsers — final event without a trailing blank line", () => {
  it("parseOpenAIStream keeps a final delta that arrives without `\\n\\n`", async () => {
    const events = await collect(parseOpenAIStream("compat", "m", streamOf([
      `${data({ choices: [{ delta: { content: "Hello" } }] })}\n\n`,
      data({ choices: [{ delta: { content: " world" } }] }) // no trailing \n\n, no [DONE]
    ])));
    expect(textOf(events)).toBe("Hello world");
    const done = events.find((e) => e.type === "done");
    expect(done?.type === "done" ? done.response.output : "").toBe("Hello world");
  });

  it("parseOpenAIStream still buffers a JSON event split across chunk boundaries", async () => {
    const events = await collect(parseOpenAIStream("compat", "m", streamOf([
      'data: {"choices":[{"delta":{"content":"Hel',
      'lo"}}]}\n\n',
      "data: [DONE]\n\n"
    ])));
    expect(textOf(events)).toBe("Hello");
  });

  it("parseOpenAIResponsesStream keeps a final delta that arrives without `\\n\\n`", async () => {
    const events = await collect(parseOpenAIResponsesStream("oa", "m", streamOf([
      'data: {"type":"response.output_text.delta","delta":"Hi"}\n\n',
      'data: {"type":"response.output_text.delta","delta":" there"}' // no trailing \n\n
    ])));
    expect(textOf(events)).toBe("Hi there");
  });

  it("does not emit a spurious event when the stream ends cleanly on `[DONE]\\n\\n`", async () => {
    const events = await collect(parseOpenAIStream("compat", "m", streamOf([
      `${data({ choices: [{ delta: { content: "done" } }] })}\n\n`,
      "data: [DONE]\n\n"
    ])));
    expect(textOf(events)).toBe("done");
  });
});
