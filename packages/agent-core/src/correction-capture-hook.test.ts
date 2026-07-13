import { describe, expect, it } from "vitest";

import { createCorrectionCaptureHook } from "./correction-capture-hook.js";
import type { AgentRunContext, Message } from "./types.js";

type Captured = { correction: string; priorAnswer: string; userId: string; request?: string };

const context = (messages: readonly Message[], userId = "stark") =>
  ({
    input: { messages, metadata: { userId } },
    runId: "r1"
  }) as unknown as AgentRunContext;

const response = (output: string) => ({ output }) as never;

const run = async (
  messages: readonly Message[],
  options: { isPaused?: () => boolean; userId?: string } = {}
): Promise<Captured[]> => {
  const captured: Captured[] = [];
  const hook = createCorrectionCaptureHook({
    enqueue: (event) => {
      captured.push(event as Captured);
    },
    ...(options.isPaused ? { isPaused: options.isPaused } : {})
  });
  await hook.afterComplete?.(context(messages, options.userId), response("네, 90만원입니다."));
  return captured;
};

const msg = (role: "user" | "assistant", content: string): Message => ({ content, role }) as Message;

describe("correction-capture hook — learning on EVERY surface, not just the chat TUI", () => {
  // Until this hook existed, distillation ran from exactly one place: the
  // interactive `muse chat` end-of-session pipeline. The web app, Telegram and
  // every API caller read the playbook but never wrote to it — they threw the
  // user's corrections away. This hook sits on the runtime's afterComplete, which
  // is the one seam every surface already passes through.
  it("captures a correction on a surface that has no session pipeline", async () => {
    const captured = await run([
      msg("user", "월세 얼마야?"),
      msg("assistant", "먼저 배경을 설명드리자면... 90만원입니다."),
      msg("user", "결론부터 말해줘. 서론 빼고.")
    ]);

    expect(captured).toHaveLength(1);
    expect(captured[0]?.correction).toBe("결론부터 말해줘. 서론 빼고.");
    expect(captured[0]?.priorAnswer).toContain("90만원");
    expect(captured[0]?.request).toBe("월세 얼마야?");
    expect(captured[0]?.userId).toBe("stark");
  });

  it("captures a redirect, not only an explicit error", async () => {
    const captured = await run([
      msg("user", "회의 정리해줘"),
      msg("assistant", "긴 산문으로 정리했습니다..."),
      msg("user", "표로 정리해줘")
    ]);
    expect(captured).toHaveLength(1);
  });

  it("enqueues nothing on a first turn — there is no answer to correct", async () => {
    expect(await run([msg("user", "더 짧게 요약해줘")])).toEqual([]);
  });

  it("enqueues nothing when the turn teaches nothing", async () => {
    expect(
      await run([msg("user", "월세 얼마야?"), msg("assistant", "90만원입니다."), msg("user", "고마워!")])
    ).toEqual([]);
  });

  it("respects a paused learner — `muse playbook pause` means pause everywhere", async () => {
    const captured = await run(
      [msg("user", "q"), msg("assistant", "a"), msg("user", "더 짧게 요약해줘")],
      { isPaused: () => true }
    );
    expect(captured).toEqual([]);
  });

  it("enqueues nothing without a user to attribute the lesson to", async () => {
    const captured: Captured[] = [];
    const hook = createCorrectionCaptureHook({
      enqueue: (event) => {
        captured.push(event as Captured);
      }
    });
    const anonymous = {
      input: { messages: [msg("user", "q"), msg("assistant", "a"), msg("user", "더 짧게")], metadata: {} },
      runId: "r1"
    } as unknown as AgentRunContext;
    await hook.afterComplete?.(anonymous, response("ok"));
    expect(captured).toEqual([]);
  });

  it("never breaks the reply when the store fails — learning is fail-soft", async () => {
    const hook = createCorrectionCaptureHook({
      enqueue: () => {
        throw new Error("disk full");
      }
    });
    await expect(
      hook.afterComplete?.(
        context([msg("user", "q"), msg("assistant", "a"), msg("user", "더 짧게 요약해줘")]),
        response("ok")
      )
    ).resolves.not.toThrow();
  });

  it("caps how much one turn can teach — a single turn is one lesson", async () => {
    const captured = await run([
      msg("user", "q1"),
      msg("assistant", "a1"),
      msg("user", "더 짧게 요약해줘"),
      msg("assistant", "a2"),
      msg("user", "표로 정리해줘")
    ]);
    expect(captured).toHaveLength(1);
  });
});
