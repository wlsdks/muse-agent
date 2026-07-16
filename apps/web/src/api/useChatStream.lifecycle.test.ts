import { describe, expect, it } from "vitest";

import { createChatStreamRequestLifecycle } from "./useChatStream.js";
import { createAskStreamRequestLifecycle } from "./useAskStream.js";

function requireRequest<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("expected a request to start");
  }
  return value;
}

describe("createChatStreamRequestLifecycle", () => {
  it("aborts and invalidates a reset request before it can commit", () => {
    const lifecycle = createChatStreamRequestLifecycle();
    const request = requireRequest(lifecycle.start());

    lifecycle.abort();

    expect(request.controller.signal.aborted).toBe(true);
    expect(lifecycle.isCurrent(request)).toBe(false);
    expect(lifecycle.finish(request)).toBe(false);
  });

  it("rejects a synchronous re-entry while the active request owns the draft", () => {
    const lifecycle = createChatStreamRequestLifecycle();
    const first = requireRequest(lifecycle.start());
    const second = lifecycle.start();

    expect(second).toBeUndefined();
    expect(first.controller.signal.aborted).toBe(false);
    expect(lifecycle.isCurrent(first)).toBe(true);
    expect(lifecycle.finish(first)).toBe(true);
    expect(lifecycle.isCurrent(first)).toBe(false);
  });

  it("gives ask streaming the same abort-and-invalidate lifecycle contract", () => {
    const lifecycle = createAskStreamRequestLifecycle();
    const request = requireRequest(lifecycle.start());

    lifecycle.abort();

    expect(request.controller.signal.aborted).toBe(true);
    expect(lifecycle.finish(request)).toBe(false);
  });
});
