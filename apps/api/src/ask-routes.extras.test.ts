import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerAskRoutes, type AskRoutesOptions } from "./ask-routes.js";

// Wiring pin: the API ask route must request CLI-grade chunk refinement
// (near-dup dedup + the Lost-in-the-Middle reorder, arXiv:2307.03172) from
// the shared recall pipeline. The refinement BEHAVIOR is unit-tested in
// @muse/recall's pipeline tests; what can silently regress here is the
// route forgetting to pass `extras.refineChunks` — which this test pins by
// spying on the pipeline entrypoints.
vi.mock("@muse/recall", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@muse/recall")>();
  return {
    ...actual,
    runGroundedRecall: vi.fn(async () => ({
      answer: "stub",
      confidence: "confident",
      matches: []
    })),
    streamGroundedRecall: vi.fn(async function* () {
      yield { kind: "done", result: { answer: "stub", confidence: "confident", matches: [] } };
    })
  };
});

import { runGroundedRecall, streamGroundedRecall } from "@muse/recall";

function routeOptions(): AskRoutesOptions {
  return {
    answerModel: "test-answerer",
    authService: undefined,
    embedFn: async () => [1, 0, 0],
    generateAnswer: async () => "unused",
    notesDir: "/tmp/unused-notes",
    notesIndexFile: "/tmp/unused-index.json"
  };
}

let server: ReturnType<typeof Fastify>;

beforeEach(() => {
  vi.clearAllMocks();
  server = Fastify();
  registerAskRoutes(server, routeOptions());
});

afterEach(async () => {
  await server.close();
});

describe("ask route → recall pipeline extras wiring", () => {
  it("passes refineChunks to runGroundedRecall (buffered path)", async () => {
    const response = await server.inject({
      method: "POST",
      payload: { question: "what is my vpn mtu?" },
      url: "/api/ask"
    });
    expect(response.statusCode).toBe(200);
    expect(runGroundedRecall).toHaveBeenCalledTimes(1);
    const input = vi.mocked(runGroundedRecall).mock.calls[0]![0];
    expect(input.extras?.refineChunks).toBe(true);
  });

  it("passes refineChunks to streamGroundedRecall (SSE path)", async () => {
    const response = await server.inject({
      headers: { accept: "text/event-stream" },
      method: "POST",
      payload: { question: "what is my vpn mtu?" },
      url: "/api/ask"
    });
    expect(response.statusCode).toBe(200);
    expect(streamGroundedRecall).toHaveBeenCalledTimes(1);
    const input = vi.mocked(streamGroundedRecall).mock.calls[0]![0];
    expect(input.extras?.refineChunks).toBe(true);
  });
});
