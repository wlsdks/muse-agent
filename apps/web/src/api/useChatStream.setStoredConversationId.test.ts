import { afterEach, describe, expect, it, vi } from "vitest";

import { setStoredConversationId } from "./useChatStream.js";

// R4-1: the Chats panel's "continue this chat" action seeds the SAME
// localStorage key the hook itself reads on mount, without needing a
// rendered hook instance — this pins the write side of that seam.

function fakeWindow() {
  const store = new Map<string, string>();
  return {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      }
    },
    store
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("setStoredConversationId", () => {
  it("writes the id to the SAME key useChatStream reads (muse.chat.conversationId)", () => {
    const { localStorage, store } = fakeWindow();
    vi.stubGlobal("window", { localStorage });

    setStoredConversationId("conv_ab12cd34");

    expect(store.get("muse.chat.conversationId")).toBe("conv_ab12cd34");
  });

  it("round-trips a telegram-origin id (with a colon) unchanged", () => {
    const { localStorage, store } = fakeWindow();
    vi.stubGlobal("window", { localStorage });

    setStoredConversationId("telegram:123");

    expect(store.get("muse.chat.conversationId")).toBe("telegram:123");
  });

  it("never throws when localStorage is unavailable (fail-soft, no crash)", () => {
    vi.stubGlobal("window", {
      localStorage: {
        setItem: () => {
          throw new Error("storage unavailable");
        }
      }
    });

    expect(() => setStoredConversationId("conv_x")).not.toThrow();
  });
});
