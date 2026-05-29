import { describe, expect, it, vi } from "vitest";

import { resolveChatMessage } from "./chat-repl.js";
import type { ProgramIO } from "./program.js";

const io = (piped: string, promptValue?: string): ProgramIO => ({
  readPipedStdin: async () => piped,
  stderr: () => {},
  stdout: () => {},
  ...(promptValue !== undefined
    ? { prompts: { text: async () => promptValue, password: async () => "", confirm: async () => true, select: async () => "" } }
    : {})
} as unknown as ProgramIO);

describe("resolveChatMessage", () => {
  it("uses the args when provided (interactive flag irrelevant)", async () => {
    expect(await resolveChatMessage(io(""), ["hello", "there"], false)).toBe("hello there");
  });

  it("concatenates args + piped stdin (instruction first)", async () => {
    expect(await resolveChatMessage(io("DOC BODY"), ["summarize"], false)).toBe("summarize\n\nDOC BODY");
  });

  it("uses piped stdin alone when no args", async () => {
    expect(await resolveChatMessage(io("piped question"), [], false)).toBe("piped question");
  });

  it("non-TTY + no args + no pipe → clear error, never the cursor-hiding @clack prompt", async () => {
    const promptSpy = vi.fn(async () => "should not be called");
    const spyIo = { ...io(""), prompts: { text: promptSpy } } as unknown as ProgramIO;
    await expect(resolveChatMessage(spyIo, [], false)).rejects.toThrow(/no message provided/);
    expect(promptSpy).not.toHaveBeenCalled();
  });

  it("interactive TTY + no args + no pipe → falls back to the prompt", async () => {
    expect(await resolveChatMessage(io("", "typed in the prompt"), [], true)).toBe("typed in the prompt");
  });
});
