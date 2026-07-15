import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ConversationList, ConversationRow, TranscriptView } from "./Chats.js";
import { DICTIONARIES } from "../i18n/strings.js";
import { I18nProvider } from "../i18n/index.js";

import type { Translate } from "../i18n/index.js";
import type { ConversationDetail, ConversationSummary } from "../api/types.js";
import type { ReactElement } from "react";

const identityT = ((key: string) => key) as unknown as Translate;

function isReactElement(node: unknown): node is ReactElement {
  return node !== null && typeof node === "object" && "props" in (node as object);
}

function collectMatching(node: unknown, predicate: (el: ReactElement) => boolean, acc: ReactElement[] = []): ReactElement[] {
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

const SUMMARY: ConversationSummary = {
  createdAt: "2026-07-10T09:00:00.000Z",
  id: "conv_ab12cd34",
  origin: "cli",
  title: "Planning the Q3 roadmap",
  turnCount: 6,
  updatedAt: "2026-07-14T09:00:00.000Z"
};

describe("ConversationRow — one conversation, click selects it", () => {
  it("renders the title, origin badge key, and turn count", () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <ConversationRow summary={SUMMARY} t={identityT} onSelect={() => {}} />
      </I18nProvider>
    );
    expect(html).toContain("Planning the Q3 roadmap");
    expect(html).toContain("chats.origin.cli");
    expect(html).toContain("conversation-row");
  });

  it("clicking the row calls onSelect with the conversation's id — never a different or empty id", () => {
    const onSelect = vi.fn();
    const tree = ConversationRow({ onSelect, summary: SUMMARY, t: identityT });
    const clickable = collectMatching(tree, (el) => typeof (el.props as { onClick?: unknown }).onClick === "function");
    expect(clickable).toHaveLength(1);
    (clickable[0]!.props as { onClick: () => void }).onClick();
    expect(onSelect).toHaveBeenCalledWith("conv_ab12cd34");
  });

  it("round-trips a telegram-origin id with a colon unchanged (onSelect gets the raw id, not URL-encoded)", () => {
    const telegramSummary: ConversationSummary = { ...SUMMARY, id: "telegram:123", origin: "telegram" };
    const onSelect = vi.fn();
    const tree = ConversationRow({ onSelect, summary: telegramSummary, t: identityT });
    const clickable = collectMatching(tree, (el) => typeof (el.props as { onClick?: unknown }).onClick === "function");
    (clickable[0]!.props as { onClick: () => void }).onClick();
    expect(onSelect).toHaveBeenCalledWith("telegram:123");
  });
});

describe("ConversationList — newest-first render order, unchanged from input", () => {
  it("renders one row per conversation, in input order", () => {
    const older: ConversationSummary = { ...SUMMARY, id: "conv_older", title: "Older chat", updatedAt: "2026-07-01T09:00:00.000Z" };
    const html = renderToStaticMarkup(
      <I18nProvider>
        <ConversationList conversations={[SUMMARY, older]} t={identityT} onSelect={() => {}} />
      </I18nProvider>
    );
    const firstIndex = html.indexOf("Planning the Q3 roadmap");
    const secondIndex = html.indexOf("Older chat");
    expect(firstIndex).toBeGreaterThanOrEqual(0);
    expect(secondIndex).toBeGreaterThan(firstIndex);
  });

  it("empty conversations renders no rows", () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <ConversationList conversations={[]} t={identityT} onSelect={() => {}} />
      </I18nProvider>
    );
    expect(html).not.toContain("conversation-row");
  });
});

const XSS_DETAIL: ConversationDetail = {
  ...SUMMARY,
  turns: [
    { content: "<script>alert('user')</script>", role: "user" },
    { content: "<img src=x onerror=alert('assistant')>", role: "assistant" }
  ]
};

describe("TranscriptView — bubble classes reused from Chat.tsx, text-only rendering", () => {
  it("renders both roles with the shared msg/bubble classes and the CLI's avatar labels", () => {
    const detail: ConversationDetail = { ...SUMMARY, turns: [{ content: "hello", role: "user" }, { content: "hi there", role: "assistant" }] };
    const html = renderToStaticMarkup(
      <I18nProvider>
        <TranscriptView conversation={detail} t={identityT} onBack={() => {}} onResume={() => {}} />
      </I18nProvider>
    );
    expect(html).toContain('class="msg user"');
    expect(html).toContain('class="msg assistant"');
    expect(html).toContain("hello");
    expect(html).toContain("hi there");
  });

  it("skips a system boundary turn — only user/assistant render", () => {
    const detail: ConversationDetail = { ...SUMMARY, turns: [{ content: "session boundary", role: "system" }, { content: "hi", role: "user" }] };
    const html = renderToStaticMarkup(
      <I18nProvider>
        <TranscriptView conversation={detail} t={identityT} onBack={() => {}} onResume={() => {}} />
      </I18nProvider>
    );
    expect(html).not.toContain("session boundary");
    expect(html).toContain("hi");
  });

  it("XSS: a <script>/onerror-bearing turn renders as ESCAPED text, never live markup", () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <TranscriptView conversation={XSS_DETAIL} t={identityT} onBack={() => {}} onResume={() => {}} />
      </I18nProvider>
    );
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x onerror=");
    expect(html).toContain("&lt;script&gt;");
  });

  it("the back button calls onBack, the resume button calls onResume", () => {
    const detail: ConversationDetail = { ...SUMMARY, turns: [] };
    const onBack = vi.fn();
    const onResume = vi.fn();
    const tree = TranscriptView({ conversation: detail, onBack, onResume, t: identityT });
    const clickable = collectMatching(tree, (el) => typeof (el.props as { onClick?: unknown }).onClick === "function");
    expect(clickable).toHaveLength(2);
    (clickable[0]!.props as { onClick: () => void }).onClick();
    (clickable[1]!.props as { onClick: () => void }).onClick();
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onResume).toHaveBeenCalledTimes(1);
  });
});

describe("Chats i18n — every chats.* / nav.chats key resolves to non-empty EN and KO copy", () => {
  it("checks every key used by this view", () => {
    const keys = [
      "nav.chats",
      "chats.subtitle",
      "chats.list",
      "chats.empty",
      "chats.emptyHint",
      "chats.startOne",
      "chats.turnCount",
      "chats.resume",
      "chats.back",
      "chats.origin.cli",
      "chats.origin.web",
      "chats.origin.telegram",
      "chats.origin.matrix",
      "chats.origin.other"
    ] as const;
    for (const key of keys) {
      expect(DICTIONARIES.en[key]).toBeTruthy();
      expect(DICTIONARIES.ko[key]).toBeTruthy();
    }
  });

  it("distinct EN/KO copy for the non-acronym keys (CLI/MCP-style acronyms legitimately match)", () => {
    const keys = ["nav.chats", "chats.subtitle", "chats.list", "chats.empty", "chats.emptyHint", "chats.startOne", "chats.resume", "chats.back"] as const;
    for (const key of keys) {
      expect(DICTIONARIES.en[key]).not.toBe(DICTIONARIES.ko[key]);
    }
  });
});
