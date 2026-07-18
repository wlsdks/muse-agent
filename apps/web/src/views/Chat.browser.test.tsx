import { useRef, useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";

import { safeSessionStorage } from "../lib/safe-storage.js";
import { applyStarterPrompt, CreateInBuilderButton, STARTER_PROMPTS, StarterChips } from "./Chat.js";
import { consumeBuilderCopilotSeed, writeBuilderCopilotSeed } from "./scheduled-logic.js";

import type { Translate } from "../i18n/index.js";

const identityT = ((key: string) => key) as unknown as Translate;

afterEach(cleanup);

function StarterPromptHarness() {
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  return (
    <>
      <StarterChips
        onPick={(prompt) => applyStarterPrompt(prompt, setDraft, textareaRef)}
        t={identityT}
      />
      <textarea
        aria-label="Message"
        onChange={(event) => setDraft(event.currentTarget.value)}
        ref={textareaRef}
        value={draft}
      />
    </>
  );
}

test("a starter prompt fills and focuses the real composer without auto-submitting", async () => {
  const prompt = STARTER_PROMPTS[0]!;
  const screen = await render(<StarterPromptHarness />);

  await screen.getByRole("button", { name: prompt.labelKey }).click();

  const composer = screen.getByRole("textbox", { name: "Message" });
  await expect.element(composer).toHaveValue(prompt.promptKey);
  await expect.element(composer).toHaveFocus();
});

// A chat response fixture carrying `builderHint` (chat-automation-honesty.ts's
// false-done correction for a recurring-automation ask) renders the "Create
// in Builder" action — clicking it writes the ONE-SHOT sessionStorage seed
// and navigates to the flows view, the exact wiring `ChatSession.createInBuilder`
// does. This harness calls the SAME real helpers (not a mock) so the seed
// round-trips through real sessionStorage.

const AUTOMATION_ASK = "매일 아침 9시에 오늘 일정 요약해주는 자동화 만들어줘";

function BuilderHintHarness({ onNavigate }: { onNavigate: (view: string) => void }) {
  const createInBuilder = (hint: string) => {
    writeBuilderCopilotSeed(safeSessionStorage(), hint);
    onNavigate("flows");
  };
  return <CreateInBuilderButton onCreate={() => createInBuilder(AUTOMATION_ASK)} t={identityT} />;
}

test("clicking 'Create in Builder' seeds the one-shot copilot handoff and navigates to flows", async () => {
  window.sessionStorage.removeItem("muse.builderCopilotSeed");
  const onNavigate = vi.fn();
  const screen = await render(<BuilderHintHarness onNavigate={onNavigate} />);

  await screen.getByRole("button", { name: "chat.automation.createInBuilder" }).click();

  expect(onNavigate).toHaveBeenCalledWith("flows");
  // The real seed helper round-trips through real sessionStorage, one-shot.
  expect(consumeBuilderCopilotSeed(safeSessionStorage())).toBe(AUTOMATION_ASK);
  expect(window.sessionStorage.getItem("muse.builderCopilotSeed")).toBeNull();
});
