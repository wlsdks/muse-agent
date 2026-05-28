import { describe, expect, it } from "vitest";

import { composeChatSystemContent } from "./commands-ask.js";

describe("composeChatSystemContent — ACE [Learned Strategies] into the chat-only ask path", () => {
  it("prepends the playbook block before the system prompt", () => {
    const out = composeChatSystemContent("You are Muse.", "[Learned Strategies]\n- keep answers under 4 sentences");
    expect(out).toBe("[Learned Strategies]\n- keep answers under 4 sentences\n\nYou are Muse.");
  });

  it("is a no-op when there are no learned strategies (prompt unchanged)", () => {
    expect(composeChatSystemContent("You are Muse.", undefined)).toBe("You are Muse.");
    expect(composeChatSystemContent("You are Muse.", "")).toBe("You are Muse.");
    expect(composeChatSystemContent("You are Muse.", "   ")).toBe("You are Muse.");
  });
});
