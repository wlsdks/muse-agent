import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";

import "../theme.css";

import { I18nProvider, useI18n } from "../i18n/index.js";
import { safeSessionStorage } from "../lib/safe-storage.js";
import {
  applyStarterPrompt,
  ChatContinuitySection,
  ChatReconfirmStrip,
  ChatSession,
  CreateInBuilderButton,
  STARTER_PROMPTS,
  StarterChips
} from "./Chat.js";
import { consumeAutoContinueThread } from "./home-logic.js";
import { consumeBuilderCopilotSeed, writeBuilderCopilotSeed } from "./scheduled-logic.js";

import type { ApiClient } from "../api/client.js";
import type { ReconfirmCard as ReconfirmCardData } from "../api/types.js";
import type { ReviewThreadSummary } from "./continuity-shared.js";
import type { ContinuityCapsulePrepareResponse } from "./ContinuityCapsule.js";
import type { Translate } from "../i18n/index.js";

const identityT = ((key: string) => key) as unknown as Translate;
const NUDGE_SUPPRESSION_KEY = "muse.chatContinuityNudge.dismissedAt";

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

// Chat's reconfirm strip (`ChatReconfirmStrip`) — the SAME "Muse가 확인하고
// 싶은 것" one-tap question Home's `ReconfirmCard` shows, surfaced in Chat too
// so a PC-only user who never opens Home still meets it. Same shared hook,
// same endpoints, same i18n strings as Home's card; these tests cover the
// chat-specific empty-session gate and the compact single-line rendering.

const RECONFIRM_FIXTURE: ReconfirmCardData = {
  category: "preference",
  evidence: "추측의 신뢰도가 12%로 옅어졌어요.",
  question: "진안은 말투에서 '간결한 답변'을(를) 선호한다고 추측하고 있어요 — 맞나요?",
  slotId: "pref-tone"
};

function TestChatReconfirmStrip(props: { readonly client: ApiClient; readonly isEmptySession: boolean }) {
  const { t } = useI18n();
  return <ChatReconfirmStrip client={props.client} isEmptySession={props.isEmptySession} t={t} />;
}

function renderReconfirmStrip(props: {
  readonly get: (path: string) => Promise<unknown>;
  readonly isEmptySession?: boolean;
  readonly post?: (path: string, body?: Record<string, unknown>) => Promise<unknown>;
}) {
  window.localStorage.setItem("muse.lang", "en");
  const forbiddenPostFn = vi.fn(async () => {
    throw new Error("unexpected POST — the reconfirm strip must never mutate on mere render");
  });
  const client = {
    baseUrl: "http://chat-reconfirm.test",
    get: props.get,
    post: props.post ?? forbiddenPostFn
  } as unknown as ApiClient;
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <TestChatReconfirmStrip client={client} isEmptySession={props.isEmptySession ?? true} />
      </I18nProvider>
    </QueryClientProvider>
  );
}

test("reconfirm strip: renders the card fixture — badge, question, and both buttons — on an EMPTY session", async () => {
  const get = vi.fn(async () => ({ card: RECONFIRM_FIXTURE }));

  const screen = await renderReconfirmStrip({ get });

  await expect.element(screen.getByText("Guess", { exact: true })).toBeVisible();
  await expect.element(screen.getByText(RECONFIRM_FIXTURE.question, { exact: true })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Yes, that's right" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "No, that's wrong" })).toBeVisible();
});

test("reconfirm strip: renders NOTHING on a non-empty session and never fetches", async () => {
  const get = vi.fn(async () => ({ card: RECONFIRM_FIXTURE }));

  const screen = await renderReconfirmStrip({ get, isEmptySession: false });

  expect(screen.container.textContent).toBe("");
  expect(get).not.toHaveBeenCalled();
});

test("reconfirm strip: the mere render never POSTs", async () => {
  const get = vi.fn(async () => ({ card: RECONFIRM_FIXTURE }));

  const screen = await renderReconfirmStrip({ get });

  await expect.element(screen.getByText(RECONFIRM_FIXTURE.question, { exact: true })).toBeVisible();
  // renderReconfirmStrip's default `post` throws if called — reaching this
  // point without a thrown assertion failure already proves no POST fired.
});

test("reconfirm strip: 맞아요/confirm click POSTs the exact verdict body then swaps to the ack line", async () => {
  const get = vi.fn(async () => ({ card: RECONFIRM_FIXTURE }));
  const post = vi.fn(async (path: string, body?: Record<string, unknown>) => {
    expect(path).toBe(`/api/user-model/reconfirm-card/${RECONFIRM_FIXTURE.slotId}`);
    expect(body).toEqual({ verdict: "confirm" });
    return { recorded: true, verdict: "confirm" };
  });

  const screen = await renderReconfirmStrip({ get, post });
  await screen.getByRole("button", { name: "Yes, that's right" }).click();

  expect(post).toHaveBeenCalledTimes(1);
  await expect.element(screen.getByText("Thanks — noted.", { exact: true })).toBeVisible();
  expect(screen.container.textContent).not.toContain(RECONFIRM_FIXTURE.question);
});

test("reconfirm strip: renders nothing when the GET errors — no error noise", async () => {
  const get = vi.fn(async () => {
    throw new Error("reconfirm-card unavailable");
  });

  const screen = await renderReconfirmStrip({ get });

  await expect.poll(() => get.mock.calls.length > 0).toBe(true);
  expect(screen.container.textContent).toBe("");
});

// The chat layout's %-height chain (theme.css `.view:has(> .chat-shell)`) —
// mounted through the SAME ancestor classes the real app nests `ChatView`
// under (`.main` > `.content` > `.view`), because the bug this regresses
// (a stale `:has()` selector no longer matching the DOM) is invisible to a
// component render that skips those wrapper classes. A fixed harness height
// stands in for the real viewport so the assertions are deterministic
// regardless of the test runner's own window size.
function ChatLayoutHarness({ client }: { readonly client: ApiClient }) {
  return (
    <div className="main" style={{ height: 640, width: 900 }}>
      <section className="content">
        <div className="view">
          <div className="chat-shell">
            <ChatSession client={client} />
          </div>
        </div>
      </section>
    </div>
  );
}

function fakeChatSessionClient(): ApiClient {
  return {
    baseUrl: "http://chat-layout.test",
    del: vi.fn(),
    get: vi.fn(async (path: string) => {
      if (path === "/api/models") return {};
      throw new Error(`unexpected GET ${path}`);
    }) as unknown as ApiClient["get"],
    patch: vi.fn(),
    post: vi.fn(),
    put: vi.fn()
  } as unknown as ApiClient;
}

function seedTranscript(turnCount: number): void {
  const turns = Array.from({ length: turnCount }, (_, i) => [
    { role: "user", text: `User message number ${i}` },
    { role: "assistant", text: `Assistant reply number ${i} — a longer answer that wraps across a couple of lines.` }
  ]).flat();
  window.localStorage.setItem("muse.chat.transcript", JSON.stringify(turns));
}

test("a seeded transcript mounts scrolled to the latest turn, not the top", async () => {
  window.localStorage.removeItem("muse.chat.conversationId");
  seedTranscript(20);

  const screen = await render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <I18nProvider>
        <ChatLayoutHarness client={fakeChatSessionClient()} />
      </I18nProvider>
    </QueryClientProvider>
  );

  await expect.element(screen.getByText("Assistant reply number 19 — a longer answer that wraps across a couple of lines.")).toBeVisible();

  const chatScroll = screen.container.querySelector(".chat-scroll") as HTMLElement | null;
  expect(chatScroll).not.toBeNull();
  await expect.poll(() => (chatScroll ? chatScroll.scrollHeight > chatScroll.clientHeight : false)).toBe(true);
  expect(chatScroll!.scrollTop).toBeGreaterThan(0);
  expect(chatScroll!.scrollTop + chatScroll!.clientHeight).toBeCloseTo(chatScroll!.scrollHeight, 0);

  window.localStorage.removeItem("muse.chat.transcript");
});

test("the chat scroller owns overflow — its .content ancestor never scrolls", async () => {
  window.localStorage.removeItem("muse.chat.conversationId");
  seedTranscript(20);

  const screen = await render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <I18nProvider>
        <ChatLayoutHarness client={fakeChatSessionClient()} />
      </I18nProvider>
    </QueryClientProvider>
  );

  await expect.element(screen.getByText("Assistant reply number 19 — a longer answer that wraps across a couple of lines.")).toBeVisible();

  const content = screen.container.querySelector(".content") as HTMLElement | null;
  const chatScroll = screen.container.querySelector(".chat-scroll") as HTMLElement | null;
  expect(content).not.toBeNull();
  expect(chatScroll).not.toBeNull();
  // The outer pane stays exactly filled (the %-height chain resolved) — only
  // the inner .chat-scroll is the bounded, overflowing scroller.
  expect(content!.scrollHeight).toBeLessThanOrEqual(content!.clientHeight + 1);
  expect(chatScroll!.scrollHeight).toBeGreaterThan(chatScroll!.clientHeight);

  window.localStorage.removeItem("muse.chat.transcript");
});

// Chat's session-open continuity nudge (`ChatContinuitySection`). Tested as
// its own component — not through the full `ChatSession` — because it needs
// only `client` + `isEmptySession`, not the session's `useChatStream` SSE
// hook; this mirrors how `StarterChips`/`ChatEmptyState` are tested via
// direct props rather than a full session mount.

const RESUMABLE_THREAD: ReviewThreadSummary = {
  id: "thread_life",
  kind: "life",
  linkCount: 1,
  links: [{ artifactId: "task_prepare", artifactType: "task", providerId: "local", role: "next-step" }],
  title: "Prepare quarterly review"
};

const READY_CAPSULE: ContinuityCapsulePrepareResponse = {
  schemaVersion: 1,
  status: "ready",
  capsule: {
    locale: "en",
    headline: "Continuity Capsule",
    threadTitle: "Prepare quarterly review",
    timingCaveat: "Muse did not evaluate whether now was a good time.",
    stoppedPoint: {
      heading: "Previously recorded next step",
      observedAt: "2026-07-30T08:00:00.000Z",
      currentAvailability: "available",
      source: {
        observation: "previous",
        status: "available",
        title: "Compare three hotels",
        summary: "Choose one candidate."
      }
    },
    changes: {
      status: "complete",
      summary: "One exact relation changed.",
      items: [{
        relationLabel: "The next-step relation changed.",
        kindLabel: "Revised",
        bindingLabel: "Named from an exact source snapshot."
      }],
      abstentions: []
    },
    nextStep: {
      heading: "Current observation's next step",
      source: {
        observation: "current",
        status: "available",
        title: "Review the changed cancellation deadline",
        summary: "One saved option expires tomorrow."
      }
    },
    preparedWork: {
      heading: "Prepared work",
      title: "Compare the changed option",
      content: "Review the changed source before choosing.",
      expectedMinutes: 12,
      expectedMinutesSemantics: "estimate",
      actionBoundary: "Display only. No action will run.",
      textOrigin: "model-generated-proposal",
      entailment: "not-verified"
    },
    disclosure: {
      heading: "Sources and integrity details",
      whyShown: "Shown because you explicitly requested this Capsule.",
      privacyNotice: "Local personal data. Source freshness is not proven.",
      previousObservedAt: "2026-07-30T08:00:00.000Z",
      currentObservedAt: "2026-07-30T09:00:00.000Z",
      preparedAt: "2026-07-30T09:00:00.000Z",
      generatedAt: "2026-07-30T09:00:01.000Z",
      verification: "citation-binding-verified",
      authenticatedWitness: "not-proven",
      sourceFreshness: "not-proven",
      currentWorldTruth: "not-granted",
      sourceCompleteness: "not-granted",
      actionAuthority: "not-granted",
      sources: [{
        observation: "previous",
        status: "available",
        title: "Compare three hotels"
      }, {
        observation: "current",
        status: "available",
        title: "Review the changed cancellation deadline"
      }],
      graphSources: { total: 1, displayed: 1, omitted: 0 }
    }
  }
};

const READY_CAPSULE_KO: ContinuityCapsulePrepareResponse = {
  ...READY_CAPSULE,
  capsule: {
    ...READY_CAPSULE.capsule,
    locale: "ko",
    headline: "연속성 캡슐",
    threadTitle: "분기 검토 준비",
    timingCaveat: "Muse는 지금이 적절한 시점인지 판단하지 않았어요.",
    stoppedPoint: {
      ...READY_CAPSULE.capsule.stoppedPoint,
      heading: "이전에 기록한 다음 단계",
      source: {
        ...READY_CAPSULE.capsule.stoppedPoint.source,
        title: "숙소 후보 세 곳 비교하기",
        summary: "후보 하나를 고르세요."
      }
    },
    nextStep: {
      ...READY_CAPSULE.capsule.nextStep,
      heading: "현재 관찰의 다음 단계",
      source: {
        ...READY_CAPSULE.capsule.nextStep.source,
        title: "변경된 취소 기한 검토하기",
        summary: "저장한 선택지 하나가 내일 만료돼요."
      }
    },
    preparedWork: {
      ...READY_CAPSULE.capsule.preparedWork,
      heading: "준비한 작업",
      title: "변경된 선택지 비교하기",
      content: "선택하기 전에 변경된 출처를 검토하세요.",
      actionBoundary: "표시만 합니다. 어떤 작업도 실행하지 않아요."
    },
    disclosure: {
      ...READY_CAPSULE.capsule.disclosure,
      heading: "출처와 무결성 세부 정보",
      whyShown: "이 캡슐을 명시적으로 요청했기 때문에 표시했어요.",
      privacyNotice: "로컬 개인 데이터예요. 출처 최신성은 증명되지 않았어요.",
      sources: [{
        observation: "previous",
        status: "available",
        title: "숙소 후보 세 곳 비교하기"
      }, {
        observation: "current",
        status: "available",
        title: "변경된 취소 기한 검토하기"
      }]
    }
  }
};

function forbiddenPost() {
  return vi.fn(async (path: string) => {
    throw new Error(`the continuity nudge must never mutate — unexpected POST ${path}`);
  });
}

function SwitchToKorean() {
  const { setLang } = useI18n();
  return <button onClick={() => setLang("ko")}>Switch to Korean</button>;
}

function renderNudge(props: {
  readonly get: (path: string) => Promise<unknown>;
  readonly isEmptySession?: boolean;
  readonly languageSwitch?: boolean;
  readonly onNavigate?: (view: string) => void;
  readonly post?: (path: string, body?: Record<string, unknown>) => Promise<unknown>;
}) {
  window.localStorage.setItem("muse.lang", "en");
  const client = { baseUrl: "http://chat-nudge.test", get: props.get, post: props.post ?? forbiddenPost() } as unknown as ApiClient;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        {props.languageSwitch ? <SwitchToKorean /> : null}
        <ChatContinuitySection client={client} isEmptySession={props.isEmptySession ?? true} onNavigate={props.onNavigate} />
      </I18nProvider>
    </QueryClientProvider>
  );
}

test("renders the nudge for a resumable review fixture, and the mere render never POSTs (read-only until clicked)", async () => {
  window.sessionStorage.removeItem(NUDGE_SUPPRESSION_KEY);
  const post = forbiddenPost();
  const get = vi.fn(async () => ({ threads: [RESUMABLE_THREAD] }));

  const screen = await renderNudge({ get, post });

  await expect.element(screen.getByText("Continue this? — Prepare quarterly review", { exact: true })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Continue" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Later" })).toBeVisible();
  expect(post).not.toHaveBeenCalled();
});

test("prepares only after one explicit click and renders the session-only seeded fallback", async () => {
  window.sessionStorage.removeItem(NUDGE_SUPPRESSION_KEY);
  const get = vi.fn(async () => ({ threads: [RESUMABLE_THREAD] }));
  const post = vi.fn(async () => ({
    schemaVersion: 1,
    status: "seeded",
    baselineDurability: "process-local-only"
  }));
  const screen = await renderNudge({ get, post });

  await screen.getByRole("button", { name: "Prepare continuity capsule" }).click();

  await expect.element(screen.getByText("Session-only baseline started")).toBeVisible();
  await expect.element(screen.getByText(
    "Muse saved a process-local starting point for this running session only. No capsule or draft was prepared yet."
  )).toBeVisible();
  expect(post).toHaveBeenCalledTimes(1);
  expect(post).toHaveBeenCalledWith(
    "/api/attunement/threads/thread_life/capsule/prepare",
    { locale: "en" }
  );
});

test("renders truthful English and Korean restart-safe seeded states after explicit clicks", async () => {
  window.sessionStorage.removeItem(NUDGE_SUPPRESSION_KEY);
  const get = vi.fn(async () => ({ threads: [RESUMABLE_THREAD] }));
  const post = vi.fn(async () => ({
    schemaVersion: 1,
    status: "seeded",
    baselineDurability: "durable-local"
  }));
  const screen = await renderNudge({
    get,
    languageSwitch: true,
    post
  });

  await screen.getByRole("button", {
    name: "Prepare continuity capsule"
  }).click();
  await expect.element(
    screen.getByText("Restart-safe baseline saved")
  ).toBeVisible();
  await expect.element(screen.getByText(
    "Muse saved this verified comparison baseline in local personal storage, so a later Muse process can use it after restart. No capsule or draft was prepared yet."
  )).toBeVisible();

  await screen.getByRole("button", { name: "Switch to Korean" }).click();
  await screen.getByRole("button", { name: "연속성 캡슐 준비" }).click();
  await expect.element(screen.getByText(
    "재시작 후에도 유지되는 기준점을 저장했어요"
  )).toBeVisible();
  await expect.element(screen.getByText(
    "검증된 비교 기준점을 로컬 개인 저장소에 저장해서 Muse가 재시작한 뒤에도 사용할 수 있어요. 아직 캡슐이나 초안은 만들지 않았어요."
  )).toBeVisible();
  expect(post).toHaveBeenCalledTimes(2);
  expect(post).toHaveBeenNthCalledWith(
    1,
    "/api/attunement/threads/thread_life/capsule/prepare",
    { locale: "en" }
  );
  expect(post).toHaveBeenNthCalledWith(
    2,
    "/api/attunement/threads/thread_life/capsule/prepare",
    { locale: "ko" }
  );
});

test("guards double-click preparation and never retries the pending mutation", async () => {
  window.sessionStorage.removeItem(NUDGE_SUPPRESSION_KEY);
  const get = vi.fn(async () => ({ threads: [RESUMABLE_THREAD] }));
  let finish!: (value: ContinuityCapsulePrepareResponse) => void;
  const post = vi.fn(() => new Promise<ContinuityCapsulePrepareResponse>(
    (resolve) => {
      finish = resolve;
    }
  ));
  const screen = await renderNudge({ get, post });
  const button = screen.getByRole("button", {
    name: "Prepare continuity capsule"
  });

  await button.click();
  await button.click({ force: true });
  expect(post).toHaveBeenCalledTimes(1);
  await expect.element(button).toBeDisabled();

  finish({
    schemaVersion: 1,
    status: "unavailable",
    reason: "busy"
  });
  await expect.element(screen.getByText(
    "A continuity capsule is already being prepared. Nothing was executed or changed."
  )).toBeVisible();
  expect(post).toHaveBeenCalledTimes(1);
});

test("renders the ready Capsule, visible truth boundaries, and keyboard-native source disclosure", async () => {
  window.sessionStorage.removeItem(NUDGE_SUPPRESSION_KEY);
  const get = vi.fn(async () => ({ threads: [RESUMABLE_THREAD] }));
  const post = vi.fn(async () => READY_CAPSULE);
  const screen = await renderNudge({ get, post });

  await screen.getByRole("button", { name: "Prepare continuity capsule" }).click();

  const heading = screen.getByRole("heading", { name: "Continuity Capsule" });
  await expect.element(heading).toBeVisible();
  await expect.element(heading).toHaveFocus();
  await expect.element(screen.getByText(
    "Compare three hotels",
    { exact: true }
  )).toBeVisible();
  await expect.element(screen.getByText("Review the changed cancellation deadline", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Estimated · 12 min")).toBeVisible();
  await expect.element(screen.getByText(
    /Sources bind this capsule to cited material; they do not prove every summary statement follows from it\./
  ).first()).toBeVisible();
  await expect.element(screen.getByText(
    /This is a proposal from your explicit request\. It does not execute a draft or make an automatic timing decision\./
  )).toBeVisible();

  const disclosure = screen.getByText("Sources and integrity details", {
    exact: true
  });
  await disclosure.click();
  await expect.element(screen.getByText(
    "Shown because you explicitly requested this Capsule."
  )).toBeVisible();
  await expect.element(screen.getByText("Citation binding", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Verified", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Semantic entailment", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Not verified", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Authenticated evidence witness", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Not proven", { exact: true }).first()).toBeVisible();
  await expect.element(screen.getByText("Source freshness", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Current-world truth", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Not granted", { exact: true }).first()).toBeVisible();
  await expect.element(screen.getByText("Source completeness", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Action authority", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Evidence prepared at", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("2026-07-30T09:00:00.000Z", { exact: true }).first()).toBeVisible();
  await expect.element(screen.getByText("Proposal generated at", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("2026-07-30T09:00:01.000Z", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Graph sources", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("1 of 1 displayed · 0 omitted", { exact: true })).toBeVisible();
  await expect.element(screen.getByText(
    /Nothing was executed or changed\./
  )).toBeVisible();
});

test("switching language clears a settled Capsule and does not prepare another one", async () => {
  window.sessionStorage.removeItem(NUDGE_SUPPRESSION_KEY);
  const get = vi.fn(async () => ({ threads: [RESUMABLE_THREAD] }));
  const post = vi.fn(async () => READY_CAPSULE);
  const screen = await renderNudge({ get, languageSwitch: true, post });

  await screen.getByRole("button", { name: "Prepare continuity capsule" }).click();
  await expect.element(screen.getByRole("heading", { name: "Continuity Capsule" })).toBeVisible();

  await screen.getByRole("button", { name: "Switch to Korean" }).click();

  await expect.element(screen.getByRole("button", { name: "연속성 캡슐 준비" })).toBeVisible();
  await expect.element(screen.getByRole("heading", { name: "Continuity Capsule" })).not.toBeInTheDocument();
  expect(post).toHaveBeenCalledTimes(1);
});

test("switching to Korean prepares a Korean ready Capsule only after a second explicit click", async () => {
  window.sessionStorage.removeItem(NUDGE_SUPPRESSION_KEY);
  const get = vi.fn(async () => ({ threads: [RESUMABLE_THREAD] }));
  const post = vi.fn(async (_path: string, body?: Record<string, unknown>) => (
    body?.locale === "ko" ? READY_CAPSULE_KO : READY_CAPSULE
  ));
  const screen = await renderNudge({ get, languageSwitch: true, post });

  await screen.getByRole("button", { name: "Prepare continuity capsule" }).click();
  await expect.element(screen.getByRole("heading", { name: "Continuity Capsule" })).toBeVisible();
  await screen.getByRole("button", { name: "Switch to Korean" }).click();
  await screen.getByRole("button", { name: "연속성 캡슐 준비" }).click();

  const koreanHeading = screen.getByRole("heading", { name: "연속성 캡슐" });
  await expect.element(koreanHeading).toBeVisible();
  await expect.element(koreanHeading).toHaveFocus();
  await expect.element(screen.getByText("숙소 후보 세 곳 비교하기", { exact: true })).toBeVisible();
  await screen.getByText("출처와 무결성 세부 정보", { exact: true }).click();
  await expect.element(screen.getByText("현재 세계 사실", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("출처 완전성", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("부여되지 않음", { exact: true }).first()).toBeVisible();
  await expect.element(screen.getByText("그래프 출처", { exact: true })).toBeVisible();
  expect(post).toHaveBeenCalledTimes(2);
  expect(post).toHaveBeenNthCalledWith(
    1,
    "/api/attunement/threads/thread_life/capsule/prepare",
    { locale: "en" }
  );
  expect(post).toHaveBeenNthCalledWith(
    2,
    "/api/attunement/threads/thread_life/capsule/prepare",
    { locale: "ko" }
  );
});

test("a rejected preparation is retried exactly once only after its explicit retry click", async () => {
  window.sessionStorage.removeItem(NUDGE_SUPPRESSION_KEY);
  const get = vi.fn(async () => ({ threads: [RESUMABLE_THREAD] }));
  const post = vi.fn()
    .mockRejectedValueOnce(new Error("client POST rejected"))
    .mockResolvedValueOnce(READY_CAPSULE);
  const screen = await renderNudge({ get, post });

  await screen.getByRole("button", { name: "Prepare continuity capsule" }).click();
  await expect.element(screen.getByRole("alert")).toHaveTextContent(
    "Muse could not prepare this continuity capsule. Nothing was executed or changed."
  );
  expect(post).toHaveBeenCalledTimes(1);

  await screen.getByRole("button", { name: "Try again" }).click();
  await expect.element(screen.getByRole("heading", { name: "Continuity Capsule" })).toBeVisible();
  expect(post).toHaveBeenCalledTimes(2);
});

test("a ready Capsule Continue only writes the existing navigation handoff", async () => {
  window.sessionStorage.removeItem(NUDGE_SUPPRESSION_KEY);
  window.sessionStorage.removeItem("muse.homeAutoContinueThreadId");
  const get = vi.fn(async () => ({ threads: [RESUMABLE_THREAD] }));
  const post = vi.fn(async () => READY_CAPSULE);
  const onNavigate = vi.fn();
  const screen = await renderNudge({ get, onNavigate, post });

  await screen.getByRole("button", { name: "Prepare continuity capsule" }).click();
  await screen.getByRole("button", { name: "Continue" }).click();

  expect(onNavigate).toHaveBeenCalledWith("home");
  expect(consumeAutoContinueThread(safeSessionStorage())).toBe("thread_life");
  expect(post).toHaveBeenCalledTimes(1);
});

test("a ready Capsule Later dismisses the full card for this session", async () => {
  window.sessionStorage.removeItem(NUDGE_SUPPRESSION_KEY);
  const get = vi.fn(async () => ({ threads: [RESUMABLE_THREAD] }));
  const screen = await renderNudge({ get, post: vi.fn(async () => READY_CAPSULE) });

  await screen.getByRole("button", { name: "Prepare continuity capsule" }).click();
  await expect.element(screen.getByRole("heading", { name: "Continuity Capsule" })).toBeVisible();
  await screen.getByRole("button", { name: "Later" }).click();

  await expect.element(screen.getByRole("heading", { name: "Continuity Capsule" })).not.toBeInTheDocument();
  expect(window.sessionStorage.getItem(NUDGE_SUPPRESSION_KEY)).not.toBeNull();
});

test("keeps a ready Capsule inside the actual phone-width Chat scroller without horizontal overflow", async () => {
  window.localStorage.removeItem("muse.chat.conversationId");
  window.localStorage.removeItem("muse.chat.transcript");
  window.localStorage.setItem("muse.lang", "en");
  window.sessionStorage.removeItem(NUDGE_SUPPRESSION_KEY);
  const client = {
    baseUrl: "http://chat-phone-layout.test",
    del: vi.fn(),
    get: vi.fn(async (path: string) => {
      if (path === "/api/models") return {};
      if (path === "/api/attunement/review") return { threads: [RESUMABLE_THREAD] };
      throw new Error(`unexpected GET ${path}`);
    }),
    patch: vi.fn(),
    post: vi.fn(async () => READY_CAPSULE),
    put: vi.fn()
  } as unknown as ApiClient;
  const screen = await render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <I18nProvider>
        <div className="main" style={{ height: 640, width: 360 }}>
          <section className="content">
            <div className="view">
              <div className="chat-shell">
                <ChatSession client={client} />
              </div>
            </div>
          </section>
        </div>
      </I18nProvider>
    </QueryClientProvider>
  );

  await screen.getByRole("button", { name: "Prepare continuity capsule" }).click();
  await expect.element(screen.getByRole("heading", { name: "Continuity Capsule" })).toBeVisible();

  const card = screen.container.querySelector<HTMLElement>(
    ".continuity-capsule-card"
  );
  const chatScroll = screen.container.querySelector<HTMLElement>(".chat-scroll");
  expect(card).not.toBeNull();
  expect(chatScroll).not.toBeNull();
  expect(card!.closest(".chat-scroll")).toBe(chatScroll);
  expect(card!.clientWidth).toBeGreaterThan(0);
  expect(chatScroll!.clientWidth).toBeGreaterThan(0);
  expect(chatScroll!.clientWidth).toBeLessThanOrEqual(360);
  expect(card!.scrollWidth).toBeLessThanOrEqual(card!.clientWidth);
  expect(chatScroll!.scrollWidth).toBeLessThanOrEqual(chatScroll!.clientWidth);
});

test("renders nothing when the review reports no resumable thread (empty threads)", async () => {
  window.sessionStorage.removeItem(NUDGE_SUPPRESSION_KEY);
  const get = vi.fn(async () => ({ threads: [] }));

  const screen = await renderNudge({ get });

  expect(screen.container.textContent).toBe("");
});

test("renders nothing when every thread's sources are external only", async () => {
  window.sessionStorage.removeItem(NUDGE_SUPPRESSION_KEY);
  const externalOnly: ReviewThreadSummary = {
    ...RESUMABLE_THREAD,
    links: [{ artifactId: "n1", artifactType: "note", providerId: "notion", role: "context" }]
  };
  const get = vi.fn(async () => ({ threads: [externalOnly] }));

  const screen = await renderNudge({ get });

  expect(screen.container.textContent).toBe("");
});

test("renders nothing when the review API errors — no error noise", async () => {
  window.sessionStorage.removeItem(NUDGE_SUPPRESSION_KEY);
  const get = vi.fn(async () => {
    throw new Error("review unavailable");
  });

  const screen = await renderNudge({ get });

  await expect.poll(() => get.mock.calls.length > 0).toBe(true);
  expect(screen.container.textContent).toBe("");
});

test("renders nothing once the session already has turns, even with a resumable thread", async () => {
  window.sessionStorage.removeItem(NUDGE_SUPPRESSION_KEY);
  const get = vi.fn(async () => ({ threads: [RESUMABLE_THREAD] }));

  const screen = await renderNudge({ get, isEmptySession: false });

  expect(screen.container.textContent).toBe("");
  expect(get).not.toHaveBeenCalled();
});

test("'Later' dismisses the nudge and it does not reappear on remount within the same session", async () => {
  window.sessionStorage.removeItem(NUDGE_SUPPRESSION_KEY);
  const get = vi.fn(async () => ({ threads: [RESUMABLE_THREAD] }));

  const first = await renderNudge({ get });
  await expect.element(first.getByText("Continue this? — Prepare quarterly review", { exact: true })).toBeVisible();
  await first.getByRole("button", { name: "Later" }).click();
  await expect.element(first.getByText("Continue this? — Prepare quarterly review", { exact: true })).not.toBeInTheDocument();

  await cleanup();
  const second = await renderNudge({ get });
  expect(second.container.textContent).toBe("");
});

test("'Continue' writes the one-shot Home handoff (the exact thread id) and navigates to home", async () => {
  window.sessionStorage.removeItem(NUDGE_SUPPRESSION_KEY);
  window.sessionStorage.removeItem("muse.homeAutoContinueThreadId");
  const get = vi.fn(async () => ({ threads: [RESUMABLE_THREAD] }));
  const onNavigate = vi.fn();

  const screen = await renderNudge({ get, onNavigate });
  await screen.getByRole("button", { name: "Continue" }).click();

  expect(onNavigate).toHaveBeenCalledWith("home");
  expect(consumeAutoContinueThread(safeSessionStorage())).toBe("thread_life");
});
