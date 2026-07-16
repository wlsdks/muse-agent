import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { STARTER_PROMPTS, StarterChips, applyStarterPrompt, ChatEmptyState, ModelChipBadge, PendingApprovals } from "./Chat.js";
import { DICTIONARIES } from "../i18n/strings.js";
import { I18nProvider } from "../i18n/index.js";

import type { PendingApproval } from "../api/useChatStream.js";
import type { ReactElement } from "react";
import type { Translate } from "../i18n/index.js";

const identityT = ((key: string) => key) as unknown as Translate;

function isReactElement(node: unknown): node is ReactElement {
  return node !== null && typeof node === "object" && "props" in (node as object);
}

/** Walks a plain (unrendered) React element tree — valid here because
 * `StarterChips` calls no hooks, so it can be invoked directly as a plain
 * function without a React render pass or DOM. */
function collectButtons(node: unknown, acc: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) {
      collectButtons(child, acc);
    }
    return acc;
  }
  if (!isReactElement(node)) {
    return acc;
  }
  if (node.type === "button") {
    acc.push(node);
  }
  const children = (node.props as { children?: unknown }).children;
  if (children !== undefined) {
    collectButtons(children, acc);
  }
  return acc;
}

describe("STARTER_PROMPTS — grounded, bilingual, distinct copy", () => {
  it("every label/prompt key resolves to non-empty, distinct EN and KO copy", () => {
    for (const { labelKey, promptKey } of STARTER_PROMPTS) {
      for (const lang of ["en", "ko"] as const) {
        expect(DICTIONARIES[lang][labelKey]).toBeTruthy();
        expect(DICTIONARIES[lang][promptKey]).toBeTruthy();
      }
      expect(DICTIONARIES.en[labelKey]).not.toBe(DICTIONARIES.ko[labelKey]);
      expect(DICTIONARIES.en[promptKey]).not.toBe(DICTIONARIES.ko[promptKey]);
    }
  });

  it("has 3-4 chips (the recommended range for a starter row)", () => {
    expect(STARTER_PROMPTS.length).toBeGreaterThanOrEqual(3);
    expect(STARTER_PROMPTS.length).toBeLessThanOrEqual(4);
  });
});

describe("StarterChips — renders one button per prompt, wired to onPick", () => {
  it("renders a labeled group with one button per starter prompt", () => {
    const html = renderToStaticMarkup(<StarterChips onPick={() => {}} t={identityT} />);
    expect(html).toContain('role="group"');
    expect(html).toContain("starter-chips");
    expect((html.match(/class="starter-chip"/g) ?? []).length).toBe(STARTER_PROMPTS.length);
    for (const { labelKey } of STARTER_PROMPTS) {
      expect(html).toContain(`>${labelKey}<`);
    }
  });

  it("clicking each chip fills the exact mapped prompt — never a different or empty string", () => {
    const onPick = vi.fn();
    // Calling the component directly is safe: it uses no hooks (`t` is a prop).
    const tree = StarterChips({ onPick, t: identityT });
    const buttons = collectButtons(tree);
    expect(buttons).toHaveLength(STARTER_PROMPTS.length);

    buttons.forEach((button, i) => {
      onPick.mockClear();
      (button.props as { onClick: () => void }).onClick();
      expect(onPick).toHaveBeenCalledTimes(1);
      expect(onPick).toHaveBeenCalledWith(STARTER_PROMPTS[i]!.promptKey);
    });
  });
});

describe("applyStarterPrompt — fill + focus, never auto-send", () => {
  it("sets the draft to the exact prompt and focuses the composer", () => {
    const setDraft = vi.fn();
    const focus = vi.fn();
    const textareaRef = { current: { focus } as unknown as HTMLTextAreaElement };

    applyStarterPrompt("Summarize my recent notes.", setDraft, textareaRef);

    expect(setDraft).toHaveBeenCalledTimes(1);
    expect(setDraft).toHaveBeenCalledWith("Summarize my recent notes.");
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("tolerates a not-yet-mounted textarea ref (no throw)", () => {
    const setDraft = vi.fn();
    const textareaRef = { current: null };
    expect(() => applyStarterPrompt("hello", setDraft, textareaRef)).not.toThrow();
    expect(setDraft).toHaveBeenCalledWith("hello");
  });
});

/** Collect every element in a plain (unrendered) tree matching a predicate —
 * used to reach the `Button` COMPONENT node (whose type is a function, not a
 * raw "button"), so we can read its props / invoke its onClick without a DOM. */
function collectMatching(
  node: unknown,
  predicate: (el: ReactElement) => boolean,
  acc: ReactElement[] = []
): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) {
      collectMatching(child, predicate, acc);
    }
    return acc;
  }
  if (!isReactElement(node)) {
    return acc;
  }
  if (predicate(node)) {
    acc.push(node);
  }
  const children = (node.props as { children?: unknown }).children;
  if (children !== undefined) {
    collectMatching(children, predicate, acc);
  }
  return acc;
}

const APPROVAL: PendingApproval = {
  draft: "Hi Sam — running 10 min late, please start without me.",
  id: "a1",
  tool: "send_message"
};

describe("PendingApprovals — draft-first write-approval cards", () => {
  it("renders the drafted content, tool, and an accessible approve group", () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <PendingApprovals approvals={[APPROVAL]} approving={[]} onApprove={() => {}} onDeny={() => {}} t={identityT} />
      </I18nProvider>
    );
    expect(html).toContain('role="group"');
    expect(html).toContain("pending-approvals");
    expect(html).toContain("send_message");
    expect(html).toContain("running 10 min late");
  });

  it("renders one Approve and one Deny button per card", () => {
    const tree = PendingApprovals({ approvals: [APPROVAL], approving: [], onApprove: () => {}, onDeny: () => {}, t: identityT });
    const clickable = collectMatching(tree, (el) => typeof (el.props as { onClick?: unknown }).onClick === "function");
    expect(clickable).toHaveLength(2);
  });

  it("the approve button calls onApprove with that approval's id", () => {
    const onApprove = vi.fn();
    const tree = PendingApprovals({ approvals: [APPROVAL], approving: [], onApprove, onDeny: () => {}, t: identityT });
    const clickable = collectMatching(tree, (el) => typeof (el.props as { onClick?: unknown }).onClick === "function");
    (clickable[0]!.props as { onClick: () => void }).onClick();
    expect(onApprove).toHaveBeenCalledWith("a1");
  });

  it("the deny button calls onDeny with that approval's id", () => {
    const onDeny = vi.fn();
    const tree = PendingApprovals({ approvals: [APPROVAL], approving: [], onApprove: () => {}, onDeny, t: identityT });
    const clickable = collectMatching(tree, (el) => typeof (el.props as { onClick?: unknown }).onClick === "function");
    expect(clickable).toHaveLength(2);
    (clickable[1]!.props as { onClick: () => void }).onClick();
    expect(onDeny).toHaveBeenCalledWith("a1");
  });

  it("disables both buttons for an approval whose confirm is in flight", () => {
    const tree = PendingApprovals({ approvals: [APPROVAL], approving: ["a1"], onApprove: () => {}, onDeny: () => {}, t: identityT });
    const clickable = collectMatching(tree, (el) => typeof (el.props as { onClick?: unknown }).onClick === "function");
    expect(clickable).toHaveLength(2);
    for (const button of clickable) {
      expect((button.props as { disabled?: boolean }).disabled).toBe(true);
    }
  });

  it("surfaces a confirm error near the buttons without dropping the approval", () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <PendingApprovals
          approvals={[APPROVAL]}
          approving={[]}
          onApprove={() => {}}
          onDeny={() => {}}
          errorText="404: unknown or expired approval"
          t={identityT}
        />
      </I18nProvider>
    );
    expect(html).toContain("banner err");
    expect(html).toContain("unknown or expired approval");
    // the card is still there for a retry
    expect(html).toContain("send_message");
  });
});

describe("ChatEmptyState — starter chips only appear in the empty state", () => {
  function render(hasMessages: boolean): string {
    return renderToStaticMarkup(
      <I18nProvider>
        <ChatEmptyState hasMessages={hasMessages} onPickStarter={() => {}} />
      </I18nProvider>
    );
  }

  it("shows the welcome copy and starter chips with real i18n labels when there are no messages", () => {
    const html = render(false);
    expect(html).toContain(DICTIONARIES.en["chat.askAnything"]);
    expect(html).toContain(DICTIONARIES.en["chat.askSub"]);
    expect(html).toContain("starter-chips");
    for (const { labelKey } of STARTER_PROMPTS) {
      expect(html).toContain(DICTIONARIES.en[labelKey]);
    }
  });

  it("renders nothing once the conversation has messages", () => {
    const html = render(true);
    expect(html).toBe("");
    expect(html).not.toContain("starter-chips");
  });
});

describe("ModelChipBadge — the current model is chrome, not a settings detail", () => {
  function render(chip: { name: string; locality: "local" | "cloud" | "unknown" }): string {
    return renderToStaticMarkup(<ModelChipBadge chip={chip} t={identityT} />);
  }

  it("shows the model name with a local badge", () => {
    const html = render({ locality: "local", name: "gemma4:12b" });
    expect(html).toContain("gemma4:12b");
    expect(html).toContain("chat.model.local");
    expect(html).not.toContain("cloud");
  });

  it("marks a cloud model with the cloud dot and label", () => {
    const html = render({ locality: "cloud", name: "claude-opus-4-8" });
    expect(html).toContain("chat.model.cloud");
    expect(html).toContain("model-chip-dot cloud");
    expect(html).not.toContain("model-chip-dot local");
  });

  it("never guesses locality for an unknown provider — name only", () => {
    const html = render({ locality: "unknown", name: "some-model" });
    expect(html).toContain("some-model");
    expect(html).not.toContain("chat.model.local");
    expect(html).not.toContain("chat.model.cloud");
  });
});
