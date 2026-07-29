import { EventEmitter } from "node:events";

import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";

import { createHttpRequestAbortScope } from "./http-request-abort.js";

function fixtures(): {
  readonly request: FastifyRequest;
  readonly requestRaw: EventEmitter & { aborted: boolean };
  readonly reply: FastifyReply;
  readonly replyRaw: EventEmitter & { writableEnded: boolean };
} {
  const requestRaw = Object.assign(new EventEmitter(), { aborted: false });
  const replyRaw = Object.assign(new EventEmitter(), { writableEnded: false });
  return {
    reply: { raw: replyRaw } as unknown as FastifyReply,
    replyRaw,
    request: { raw: requestRaw } as unknown as FastifyRequest,
    requestRaw
  };
}

describe("createHttpRequestAbortScope", () => {
  it("does not mistake normal request/response completion for cancellation", () => {
    const { reply, replyRaw, request, requestRaw } = fixtures();
    const scope = createHttpRequestAbortScope(request, reply);

    requestRaw.emit("close");
    replyRaw.writableEnded = true;
    replyRaw.emit("close");

    expect(scope.signal.aborted).toBe(false);
    scope.dispose();
  });

  it("aborts for an already-aborted request or a premature response close", () => {
    const already = fixtures();
    already.requestRaw.aborted = true;
    const alreadyScope = createHttpRequestAbortScope(already.request, already.reply);
    expect(alreadyScope.signal.aborted).toBe(true);
    alreadyScope.dispose();

    const premature = fixtures();
    const prematureScope = createHttpRequestAbortScope(premature.request, premature.reply);
    premature.replyRaw.emit("close");
    expect(prematureScope.signal.aborted).toBe(true);
    prematureScope.dispose();
  });

  it("removes every scoped listener on dispose", () => {
    const { reply, replyRaw, request, requestRaw } = fixtures();
    const baselines = {
      requestAborted: requestRaw.listenerCount("aborted"),
      requestClose: requestRaw.listenerCount("close"),
      responseClose: replyRaw.listenerCount("close")
    };
    const scope = createHttpRequestAbortScope(request, reply);
    expect(requestRaw.listenerCount("aborted")).toBe(baselines.requestAborted + 1);
    expect(requestRaw.listenerCount("close")).toBe(baselines.requestClose + 1);
    expect(replyRaw.listenerCount("close")).toBe(baselines.responseClose + 1);

    scope.dispose();

    expect(requestRaw.listenerCount("aborted")).toBe(baselines.requestAborted);
    expect(requestRaw.listenerCount("close")).toBe(baselines.requestClose);
    expect(replyRaw.listenerCount("close")).toBe(baselines.responseClose);
  });
});
