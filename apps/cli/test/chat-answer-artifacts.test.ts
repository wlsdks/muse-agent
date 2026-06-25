import { describe, expect, it } from "vitest";

import { stripChatAnswerArtifacts } from "../src/chat-grounding.js";

describe("stripChatAnswerArtifacts (chat post-gate strips — ask parity)", () => {
  it("strips an echoed grounding FENCE tag from the answer", () => {
    const out = stripChatAnswerArtifacts("Your VPN is on. <<memory 3 — vpn.md>> <<end>>", ["vpn.md"]);
    expect(out).not.toContain("<<memory");
    expect(out).not.toContain("<<end>>");
    expect(out).toContain("Your VPN is on.");
  });

  it("also drops a fabricated citation (source not retrieved)", () => {
    const out = stripChatAnswerArtifacts("The cat is 보리 [from ghost.md]", ["vpn.md"]);
    expect(out).not.toContain("ghost.md");
  });

  it("keeps a valid citation untouched", () => {
    const out = stripChatAnswerArtifacts("VPN on [from vpn.md]", ["vpn.md"]);
    expect(out).toContain("[from vpn.md]");
  });
});
