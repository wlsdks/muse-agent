import { describe, expect, it } from "vitest";

import { recordChatTurnTrace } from "./chat-repl.js";

type Written = { workspaceDir: string; entry: Record<string, unknown> };

function captureWrite(): { written: Written[]; write: (dir: string, entry: never) => Promise<string> } {
  const written: Written[] = [];
  return {
    write: async (workspaceDir: string, entry: never) => {
      written.push({ entry: entry as Record<string, unknown>, workspaceDir });
      return "run-id";
    },
    written
  };
}

describe("recordChatTurnTrace — one outcome-labelled trace per chat turn, every surface", () => {
  it("labels a grounded answer 'grounded' with the cli.ink source", async () => {
    const { write, written } = captureWrite();
    await recordChatTurnTrace({
      answer: "Your VPN MTU is 1380. (근거: vpn.md)",
      matches: [{ cosine: 0.7, score: 0.7, source: "vpn.md", text: "WireGuard VPN MTU is 1380 on the home network." }],
      question: "what MTU does my VPN use?",
      source: "cli.ink"
    }, write as never);
    expect(written).toHaveLength(1);
    const response = written[0]!.entry.response as { grounded: unknown };
    expect(response.grounded).toBe("grounded");
    expect(written[0]!.entry.source).toBe("cli.ink");
  });

  it("a casual turn asserts no claim — grounded stays null (never pollutes the flywheel)", async () => {
    const { write, written } = captureWrite();
    await recordChatTurnTrace({
      answer: "안녕하세요! 무엇을 도와드릴까요?",
      matches: [],
      question: "안녕!",
      source: "cli.ink"
    }, write as never);
    const response = written[0]!.entry.response as { grounded: unknown };
    expect(response.grounded).toBeNull();
  });

  it("an evidence-less refusal is labelled 'abstain' (error-analysis fuel)", async () => {
    const { write, written } = captureWrite();
    await recordChatTurnTrace({
      answer: "I'm not sure — your notes don't cover that.",
      matches: [],
      question: "what is my aunt's cat's name?",
      source: "cli.local"
    }, write as never);
    const response = written[0]!.entry.response as { grounded: unknown };
    expect(response.grounded).toBe("abstain");
  });

  it("a write failure is swallowed — the turn is never disturbed by logging", async () => {
    await expect(recordChatTurnTrace({
      answer: "answer",
      matches: [],
      question: "a real question about my notes",
      source: "cli.ink"
    }, (async () => { throw new Error("disk full"); }) as never)).resolves.toBeUndefined();
  });
});
