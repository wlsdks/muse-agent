import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { writeAutoContinueThread } from "./home-logic.js";
import type { ApiClient } from "../api/client.js";
import type { DayRhythmStateResponse, MessagingSetupResponse, ReconfirmCard as ReconfirmCardData } from "../api/types.js";
import type { OpenedPack, ReviewThreadSummary } from "./continuity-shared.js";
import type { PersonalStatusCard, PersonalStatusResponse } from "@muse/shared";
import { I18nProvider, useI18n } from "../i18n/index.js";
import { DayRhythmCard, HomeView, ReconfirmCard } from "./Home.js";

afterEach(cleanup);

const TELEGRAM_PROVIDERS: MessagingSetupResponse["providers"] = [
  {
    configured: true,
    displayName: "Telegram",
    docsUrl: "https://core.telegram.org/bots#botfather",
    id: "telegram",
    pairedOwner: "555",
    registered: true,
    source: "file"
  }
];

function TestCard(props: {
  readonly client: ApiClient;
  readonly messagingProviders?: MessagingSetupResponse["providers"];
  readonly onNavigate?: (view: string) => void;
}) {
  const { t } = useI18n();
  return <DayRhythmCard client={props.client} messagingProviders={props.messagingProviders} onNavigate={props.onNavigate} t={t} />;
}

function renderCard(props: {
  readonly get: (path: string) => Promise<unknown>;
  readonly post: (path: string, body?: Record<string, unknown>) => Promise<unknown>;
  readonly messagingProviders?: MessagingSetupResponse["providers"];
  readonly onNavigate?: (view: string) => void;
}) {
  window.localStorage.setItem("muse.lang", "en");
  const forbidden = vi.fn(async () => {
    throw new Error("unexpected mutating API call");
  });
  const client = {
    baseUrl: "http://day-rhythm.test",
    del: forbidden,
    get: props.get,
    patch: forbidden,
    post: props.post,
    put: forbidden
  } as unknown as ApiClient;
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <TestCard client={client} messagingProviders={props.messagingProviders} onNavigate={props.onNavigate} />
      </I18nProvider>
    </QueryClientProvider>
  );
}

test("off state: shows the one-line explainer and a single turn-on button", async () => {
  const state: DayRhythmStateResponse = { enabled: false, eveningHour: 18, morningHour: 8, pairedChannel: null };
  const get = vi.fn(async () => state);
  const post = vi.fn(async () => { throw new Error("should not POST in this test"); });

  const screen = await renderCard({ get, post });

  await expect.element(screen.getByText("Day rhythm", { exact: true })).toBeVisible();
  await expect.element(
    screen.getByText("Turn this on and Muse sends a morning briefing and an evening wrap-up to your paired channel automatically.", { exact: true })
  ).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Turn on day rhythm" })).toBeVisible();
  expect(screen.container.textContent).not.toContain("Morning briefing");
});

test("unpaired state: honest message + a deep link into 연동/integrations, never a silent send", async () => {
  const state: DayRhythmStateResponse = { enabled: true, eveningHour: 18, morningHour: 8, pairedChannel: null };
  const get = vi.fn(async () => state);
  const post = vi.fn(async () => { throw new Error("should not POST in this test"); });
  const onNavigate = vi.fn();

  const screen = await renderCard({ get, onNavigate, post });

  await expect.element(
    screen.getByText("Day rhythm is on, but no channel is paired yet — nothing can be delivered.", { exact: true })
  ).toBeVisible();
  const link = screen.getByRole("button", { name: "Connect a channel →" });
  await expect.element(link).toBeVisible();
  await link.click();
  expect(onNavigate).toHaveBeenCalledWith("integrations");
  expect(post).not.toHaveBeenCalled();
});

test("on state: shows the morning/evening times + the paired channel's display name, and 'turn off' POSTs enabled:false", async () => {
  let current: DayRhythmStateResponse = {
    enabled: true,
    eveningHour: 19,
    morningHour: 7,
    pairedChannel: { destination: "555", providerId: "telegram" }
  };
  const get = vi.fn(async () => current);
  const post = vi.fn(async (path: string, body?: Record<string, unknown>) => {
    expect(path).toBe("/api/day-rhythm");
    expect(body).toEqual({ enabled: false });
    current = { ...current, enabled: false, pairedChannel: null };
    return current;
  });

  const screen = await renderCard({ get, messagingProviders: TELEGRAM_PROVIDERS, post });

  await expect.element(screen.getByText("Morning briefing ~7:00 · Evening wrap-up ~19:00", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("via Telegram", { exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "Turn off" }).click();

  expect(post).toHaveBeenCalledTimes(1);
  await expect.element(screen.getByRole("button", { name: "Turn on day rhythm" })).toBeVisible();
});

const RESUMABLE_THREAD: ReviewThreadSummary = {
  id: "thread_life",
  kind: "life",
  linkCount: 1,
  links: [{ artifactId: "task_prepare", artifactType: "task", providerId: "local", role: "next-step" }],
  title: "Prepare quarterly review"
};

function openedPackFixture(): OpenedPack {
  const artifact = {
    artifactId: "task_prepare",
    artifactType: "task",
    providerId: "local",
    role: "next-step",
    taskStatus: "open" as const,
    title: "Send the agenda"
  };
  return {
    delivery: { id: "delivery_home" },
    pack: {
      evidence: [{
        artifact,
        reference: { artifactId: artifact.artifactId, artifactType: artifact.artifactType, providerId: artifact.providerId, role: artifact.role },
        status: "available"
      }],
      nextStep: artifact,
      policy: { nextStep: "direct" },
      thread: { kind: "life", title: RESUMABLE_THREAD.title }
    }
  };
}

/** Every endpoint HomeView (and the TodaySections it always renders)
 * queries, given a safe, minimal fixture — so only the Continuity Pack
 * seam under test needs a meaningful response. */
function personalStatus(cards: readonly PersonalStatusCard[]): PersonalStatusResponse {
  return {
    cards,
    generatedAt: "2026-07-22T12:00:00.000Z",
    overall: cards.some((card) => card.status === "held") ? "held" : cards.some((card) => card.status === "attention") ? "attention" : "clear",
    schemaVersion: "muse.personal-status/v1",
    sources: []
  };
}

function homeGet(overrides: {
  readonly reconfirm?: ReconfirmCardData | null;
  readonly status?: PersonalStatusResponse;
  readonly threads?: readonly ReviewThreadSummary[];
} = {}) {
  return vi.fn(async (path: string) => {
    if (path === "/api/health") return { status: "ok" };
    if (path === "/api/models") return { active: undefined, defaultModel: undefined, models: [] };
    if (path === "/api/messaging/setup") return { providers: [] };
    if (path === "/api/email/status") return { configured: false };
    if (path === "/api/settings/daemon-flags") return { flags: [] };
    if (path === "/api/day-rhythm") return { enabled: false, eveningHour: 18, morningHour: 8, pairedChannel: null };
    if (path === "/api/user-memory/default") return { facts: {} };
    if (path === "/api/attunement/review") return { threads: overrides.threads ?? [RESUMABLE_THREAD] };
    if (path === "/api/user-model/reconfirm-card") return { card: overrides.reconfirm ?? null };
    if (path === "/api/personal-status") return overrides.status ?? personalStatus([]);
    return {};
  });
}

test("approval queue opens a separate dialog and only the explicit dialog decision POSTs once", async () => {
  const card: PersonalStatusCard = {
    action: { id: "review-approval", target: { itemId: "approval_1", review: "approval", type: "local-review" } },
    deadline: "2026-07-22T13:00:00.000Z",
    detail: "send_message · execute · owner confirmation required",
    id: "approval:approval_1",
    kind: "external-approval",
    observedAt: "2026-07-22T11:00:00.000Z",
    priority: 20,
    sourceId: "pending-approvals",
    status: "attention",
    title: "Approval waiting"
  };
  const get = homeGet({ status: personalStatus([card]) });
  const post = vi.fn(async (path: string) => {
    expect(path).toBe("/api/chat/approvals/approval_1/approve");
    return {};
  });
  const screen = await renderHome({ get, post });

  await screen.getByRole("button", { name: "Review" }).click();
  await expect.element(screen.getByRole("dialog", { name: "Approval waiting" })).toBeVisible();
  expect(post).not.toHaveBeenCalled();
  await expect.element(screen.getByRole("button", { name: "Approve once" })).toHaveFocus();
  await userEvent.tab();
  await expect.element(screen.getByRole("button", { name: "Deny" })).toHaveFocus();
  await userEvent.tab();
  await expect.element(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  await screen.getByRole("button", { name: "Cancel" }).click();
  expect(post).not.toHaveBeenCalled();

  await screen.getByRole("button", { name: "Review" }).click();
  await screen.getByRole("button", { name: "Approve once" }).click();
  expect(post).toHaveBeenCalledTimes(1);
  await expect.element(screen.getByRole("dialog", { name: "Approval waiting" })).not.toBeInTheDocument();
});

test.each([
  ["en", ["Copy status command", "Review", "Copy review command", "Review feedback", "Open continuity", "Review memory", "Open learning history", "Open avoidances"]],
  ["ko", ["상태 명령 복사", "검토하기", "검토 명령 복사", "피드백 검토", "연속성 열기", "기억 확인", "배움 이력 열기", "하지 않을 것 열기"]]
] as const)("%s exposes an accessible action name for every personal-status family", async (lang, names) => {
  const cards: readonly PersonalStatusCard[] = [
    { action: { id: "inspect-runtime", target: { command: "muse daemon --status", type: "command" } }, deadline: null, detail: "runtime", id: "runtime:resident", kind: "runtime-trust", observedAt: "2026-07-22T10:00:00.000Z", priority: 10, sourceId: "resident-runtime", status: "held", title: "Runtime" },
    { action: { id: "review-approval", target: { itemId: "a1", review: "approval", type: "local-review" } }, deadline: "2026-07-22T13:00:00.000Z", detail: "approval", id: "approval:a1", kind: "external-approval", observedAt: "2026-07-22T10:00:00.000Z", priority: 20, sourceId: "pending-approvals", status: "attention", title: "Approval" },
    { action: { id: "show-proposal-command", target: { command: "muse propose list", type: "command" } }, deadline: "2026-07-22T13:00:00.000Z", detail: "proposal", id: "proposal:p1", kind: "external-proposal", observedAt: "2026-07-22T10:00:00.000Z", priority: 20, sourceId: "proposed-actions", status: "attention", title: "Proposal" },
    { action: { id: "review-continuity-feedback", target: { focus: "continuity-feedback-review", type: "view", view: "continuity" } }, deadline: null, detail: "feedback", id: "feedback:d1", kind: "continuity-feedback", observedAt: "2026-07-22T10:00:00.000Z", priority: 30, sourceId: "attunement", status: "attention", title: "Feedback" },
    { action: { id: "open-continuity", target: { type: "view", view: "continuity" } }, deadline: null, detail: "thread", id: "thread:t1", kind: "continuity-thread", observedAt: "2026-07-22T10:00:00.000Z", priority: 50, sourceId: "attunement", status: "ready", title: "Thread" },
    { action: { id: "review-learning", target: { focus: "memory-reconfirm", type: "local-focus" } }, deadline: null, detail: "review", id: "learning-review:s1", kind: "learning-review", observedAt: "2026-07-22T10:00:00.000Z", priority: 40, sourceId: "reconfirmation", status: "attention", title: "Memory" },
    { action: { id: "open-learning-history", target: { focus: "learning-history", type: "view", view: "journey" } }, deadline: null, detail: "learning", id: "learning:fact:k1", kind: "learning-change", observedAt: "2026-07-22T10:00:00.000Z", priority: 60, sourceId: "belief-provenance", status: "info", title: "Learning" },
    { action: { id: "open-vetoes", target: { focus: "vetoes", type: "view", view: "autonomy" } }, deadline: null, detail: "veto", id: "veto:v1", kind: "veto", observedAt: "2026-07-22T10:00:00.000Z", priority: 60, sourceId: "vetoes", status: "info", title: "Veto" }
  ];
  const screen = await renderHome({ get: homeGet({ status: personalStatus(cards) }), lang, post: vi.fn() });
  for (const name of names) await expect.element(screen.getByRole("button", { name, exact: true })).toBeVisible();
});

test("runtime and proposal commands copy their exact read-only CLI commands without posting", async () => {
  const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const cards: readonly PersonalStatusCard[] = [
    { action: { id: "inspect-runtime", target: { command: "muse daemon --status", type: "command" } }, deadline: null, detail: "runtime", id: "runtime:resident", kind: "runtime-trust", observedAt: "2026-07-22T10:00:00.000Z", priority: 10, sourceId: "resident-runtime", status: "held", title: "Runtime" },
    { action: { id: "show-proposal-command", target: { command: "muse propose list", type: "command" } }, deadline: "2026-07-22T13:00:00.000Z", detail: "proposal", id: "proposal:p1", kind: "external-proposal", observedAt: "2026-07-22T10:00:00.000Z", priority: 20, sourceId: "proposed-actions", status: "attention", title: "Proposal" }
  ];
  const post = vi.fn();
  const screen = await renderHome({ get: homeGet({ status: personalStatus(cards) }), post });
  await screen.getByRole("button", { name: "Copy status command" }).click();
  await screen.getByRole("button", { name: "Copy review command" }).click();
  expect(writeText).toHaveBeenNthCalledWith(1, "muse daemon --status");
  expect(writeText).toHaveBeenNthCalledWith(2, "muse propose list");
  expect(post).not.toHaveBeenCalled();
});

test("continuity feedback action carries the exact view and focus intent without posting", async () => {
  const card: PersonalStatusCard = {
    action: { id: "review-continuity-feedback", target: { focus: "continuity-feedback-review", type: "view", view: "continuity" } },
    deadline: null,
    detail: "Owner feedback is ready",
    id: "feedback:delivery_1",
    kind: "continuity-feedback",
    observedAt: "2026-07-22T11:00:00.000Z",
    priority: 30,
    sourceId: "attunement",
    status: "attention",
    title: "Review the outcome"
  };
  const onNavigate = vi.fn();
  const post = vi.fn(async () => { throw new Error("status navigation must not POST"); });
  const screen = await renderHome({ get: homeGet({ status: personalStatus([card]) }), onNavigate, post });

  await screen.getByRole("button", { name: "Review feedback" }).click();
  expect(onNavigate).toHaveBeenCalledWith("continuity");
  expect(window.sessionStorage.getItem("muse.personal-status.focus.v1")).toContain("continuity-feedback-review");
  expect(post).not.toHaveBeenCalled();
});

function renderHome(props: {
  readonly get: ReturnType<typeof homeGet>;
  readonly lang?: "en" | "ko";
  readonly post: (path: string, body?: Record<string, unknown>) => Promise<unknown>;
  readonly onNavigate?: (view: string) => void;
}) {
  window.localStorage.setItem("muse.lang", props.lang ?? "en");
  const client = {
    baseUrl: "http://home-pack.test",
    get: props.get,
    post: props.post
  } as unknown as ApiClient;
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <HomeView client={client} onNavigate={props.onNavigate} />
      </I18nProvider>
    </QueryClientProvider>
  );
}

test("KO status actions keep exact navigation targets and local memory focus", async () => {
  const cards: readonly PersonalStatusCard[] = [
    {
      action: { id: "open-continuity", target: { type: "view", view: "continuity" } }, deadline: null, detail: "다시 이어갈 수 있어요", id: "thread:t1",
      kind: "continuity-thread", observedAt: "2026-07-22T10:00:00.000Z", priority: 50, sourceId: "attunement", status: "ready", title: "출시"
    },
    {
      action: { id: "review-learning", target: { focus: "memory-reconfirm", type: "local-focus" } }, deadline: null, detail: "확인 필요", id: "learning-review:s1",
      kind: "learning-review", observedAt: "2026-07-22T10:00:00.000Z", priority: 40, sourceId: "reconfirmation", status: "attention", title: "기억"
    },
    {
      action: { id: "open-learning-history", target: { focus: "learning-history", type: "view", view: "journey" } }, deadline: null, detail: "근거 있는 변경", id: "learning:fact:k1",
      kind: "learning-change", observedAt: "2026-07-22T10:00:00.000Z", priority: 60, sourceId: "belief-provenance", status: "info", title: "집중 시간"
    },
    {
      action: { id: "open-vetoes", target: { focus: "vetoes", type: "view", view: "autonomy" } }, deadline: null, detail: "사용자가 정한 제약", id: "veto:v1",
      kind: "veto", observedAt: "2026-07-22T10:00:00.000Z", priority: 60, sourceId: "vetoes", status: "info", title: "먼저 묻기"
    }
  ];
  const onNavigate = vi.fn();
  const post = vi.fn(async () => { throw new Error("navigation must not POST"); });
  const screen = await renderHome({
    get: homeGet({
      reconfirm: { category: "preference", question: "아침 집중이 맞나요?", slotId: "s1" },
      status: personalStatus(cards)
    }),
    lang: "ko",
    onNavigate,
    post
  });

  await screen.getByRole("button", { name: "기억 확인" }).click();
  await expect.poll(() => document.activeElement?.id).toBe("memory-reconfirm");
  await screen.getByRole("button", { name: "연속성 열기" }).click();
  expect(onNavigate).toHaveBeenLastCalledWith("continuity");
  await screen.getByRole("button", { name: "배움 이력 열기" }).click();
  expect(onNavigate).toHaveBeenLastCalledWith("journey");
  expect(window.sessionStorage.getItem("muse.personal-status.focus.v1")).toContain("learning-history");
  await screen.getByRole("button", { name: "하지 않을 것 열기" }).click();
  expect(onNavigate).toHaveBeenLastCalledWith("autonomy");
  expect(window.sessionStorage.getItem("muse.personal-status.focus.v1")).toContain("vetoes");
  expect(post).not.toHaveBeenCalled();
});

test("a resumable thread's inline 'Next step' opens its Pack, records the exact outcome POST, then collapses with a confirmation", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const get = homeGet();
  const post = vi.fn(async (path: string) => {
    if (path === "/api/attunement/threads/thread_life/continue") return openedPackFixture();
    if (path === "/api/attunement/deliveries/delivery_home/outcome") return {};
    throw new Error(`unexpected POST ${path}`);
  });

  const screen = await renderHome({ get, post });

  await expect.element(screen.getByText("Prepare quarterly review", { exact: true })).toBeVisible();
  // Read-only until clicked: rendering Home never opens a Pack or records an outcome by itself.
  expect(post).not.toHaveBeenCalled();

  await screen.getByRole("button", { name: "Next step" }).click();

  expect(post).toHaveBeenCalledWith("/api/attunement/threads/thread_life/continue");
  await expect.element(screen.getByText("Continuity Pack: Prepare quarterly review", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Next step: Send the agenda", { exact: true })).toBeVisible();
  const usedButton = screen.getByRole("button", { name: "Record used for delivery_home" });
  await expect.element(usedButton).toBeVisible();

  await usedButton.click();

  expect(post).toHaveBeenCalledWith("/api/attunement/deliveries/delivery_home/outcome", { outcome: "used" });
  await expect.element(screen.getByText("Continuity Pack: Prepare quarterly review", { exact: true })).not.toBeInTheDocument();
  await expect.element(screen.getByText("Recorded: used", { exact: true })).toBeVisible();
});

test("a thread with only external sources keeps the plain 'Continue' navigation button, never an inline Pack-open", async () => {
  const externalThread: ReviewThreadSummary = {
    id: "thread_ext",
    kind: "work",
    linkCount: 1,
    links: [{ artifactId: "note_1", artifactType: "note", providerId: "notion", role: "context" }],
    title: "External-only thread"
  };
  const get = homeGet({ threads: [externalThread] });
  const onNavigate = vi.fn();
  const post = vi.fn(async () => {
    throw new Error("should not POST for an external-source thread");
  });

  const screen = await renderHome({ get, onNavigate, post });

  await expect.element(screen.getByRole("button", { name: "Continue", exact: true })).toBeVisible();
  expect(screen.container.textContent).not.toContain("Next step");
  await screen.getByRole("button", { name: "Continue", exact: true }).click();

  expect(onNavigate).toHaveBeenCalledWith("continuity");
  expect(post).not.toHaveBeenCalled();
});

test("a chat handoff to a thread BELOW the top-2 slice still renders its pack inline (no orphaned delivery)", async () => {
  const emptyThread = (id: string, title: string): ReviewThreadSummary => ({
    ...RESUMABLE_THREAD,
    id,
    linkCount: 0,
    links: [],
    title
  });
  const below: ReviewThreadSummary = { ...RESUMABLE_THREAD, id: "t_c", title: "옛 스레드" };
  const get = homeGet({ threads: [emptyThread("t_a", "새 스레드 A"), emptyThread("t_b", "새 스레드 B"), below] });
  const post = vi.fn(async (path: string) => {
    if (path === "/api/attunement/threads/t_c/continue") return { ...openedPackFixture(), threadId: "t_c" };
    return {};
  });
  writeAutoContinueThread(window.sessionStorage, "t_c");

  await renderHome({ get, post });

  await expect.poll(() => post.mock.calls.filter((call) => String(call[0]).includes("/continue")).length).toBe(1);
  await expect.poll(() => document.body.textContent?.includes("옛 스레드")).toBe(true);
  await expect.poll(() =>
    [...document.querySelectorAll("button")].some((button) => /used|썼어요/iu.test(button.textContent ?? ""))
  ).toBe(true);
});

function TestReconfirmCard(props: { readonly client: ApiClient }) {
  const { t } = useI18n();
  return <ReconfirmCard client={props.client} t={t} />;
}

function renderReconfirmCard(props: {
  readonly get: (path: string) => Promise<unknown>;
  readonly post: (path: string, body?: Record<string, unknown>) => Promise<unknown>;
}) {
  window.localStorage.setItem("muse.lang", "en");
  const forbidden = vi.fn(async () => {
    throw new Error("unexpected mutating API call");
  });
  const client = {
    baseUrl: "http://reconfirm-card.test",
    del: forbidden,
    get: props.get,
    patch: forbidden,
    post: props.post,
    put: forbidden
  } as unknown as ApiClient;
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <TestReconfirmCard client={client} />
      </I18nProvider>
    </QueryClientProvider>
  );
}

const RECONFIRM_FIXTURE: ReconfirmCardData = {
  category: "preference",
  evidence: "추측의 신뢰도가 12%로 옅어졌어요.",
  question: "진안은 말투에서 '간결한 답변'을(를) 선호한다고 추측하고 있어요 — 맞나요?",
  slotId: "pref-tone"
};

test("reconfirm card: renders NOTHING when the API returns { card: null } — silent, no empty shell", async () => {
  const get = vi.fn(async () => ({ card: null }));
  const post = vi.fn(async () => { throw new Error("should not POST when there is no card"); });

  const screen = await renderReconfirmCard({ get, post });

  await expect.poll(() => get.mock.calls.length).toBeGreaterThan(0);
  expect(screen.container.textContent).toBe("");
});

test("reconfirm card: shows the 추론 label, the question, evidence, and both buttons when a card is present", async () => {
  const get = vi.fn(async () => ({ card: RECONFIRM_FIXTURE }));
  const post = vi.fn(async () => { throw new Error("should not POST before a click"); });

  const screen = await renderReconfirmCard({ get, post });

  await expect.element(screen.getByText("Guess", { exact: true })).toBeVisible();
  await expect.element(screen.getByText(RECONFIRM_FIXTURE.question, { exact: true })).toBeVisible();
  await expect.element(screen.getByText(RECONFIRM_FIXTURE.evidence!, { exact: true })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Yes, that's right" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "No, that's wrong" })).toBeVisible();
});

test("reconfirm card: 맞아요/confirm POSTs the exact verdict body then swaps to the confirmed acknowledgment", async () => {
  const get = vi.fn(async () => ({ card: RECONFIRM_FIXTURE }));
  const post = vi.fn(async (path: string, body?: Record<string, unknown>) => {
    expect(path).toBe(`/api/user-model/reconfirm-card/${RECONFIRM_FIXTURE.slotId}`);
    expect(body).toEqual({ verdict: "confirm" });
    return { recorded: true, verdict: "confirm" };
  });

  const screen = await renderReconfirmCard({ get, post });
  await screen.getByRole("button", { name: "Yes, that's right" }).click();

  expect(post).toHaveBeenCalledTimes(1);
  await expect.element(screen.getByText("Thanks — noted.", { exact: true })).toBeVisible();
  expect(screen.container.textContent).not.toContain(RECONFIRM_FIXTURE.question);
});

test("reconfirm card: 아니에요/reject POSTs the exact verdict body then swaps to the rejected acknowledgment", async () => {
  const get = vi.fn(async () => ({ card: RECONFIRM_FIXTURE }));
  const post = vi.fn(async (path: string, body?: Record<string, unknown>) => {
    expect(path).toBe(`/api/user-model/reconfirm-card/${RECONFIRM_FIXTURE.slotId}`);
    expect(body).toEqual({ verdict: "reject" });
    return { recorded: true, verdict: "reject" };
  });

  const screen = await renderReconfirmCard({ get, post });
  await screen.getByRole("button", { name: "No, that's wrong" }).click();

  expect(post).toHaveBeenCalledTimes(1);
  await expect.element(screen.getByText("Thanks for the correction — I won't guess that again.", { exact: true })).toBeVisible();
  expect(screen.container.textContent).not.toContain(RECONFIRM_FIXTURE.question);
});

test("a FAILED reconfirm answer shows a retry line and keeps the card interactive", async () => {
  const get = homeGet();
  (get as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
    if (path === "/api/user-model/reconfirm-card") {
      return { card: { category: "preference", evidence: "추측의 신뢰도가 10%로 옅어졌어요.", question: "진안의 취향 — 이렇게 추측하고 있어요: '아침형 작업'. 아직 맞나요?", slotId: "pref_x" } };
    }
    return homeGet()(path);
  });
  const post = vi.fn(async (path: string) => {
    if (path.includes("/reconfirm-card/")) throw new Error("boom");
    return {};
  });
  const screen = await renderHome({ get, post });

  await screen.getByRole("button", { name: /맞아요|Yes/i }).click();
  await expect.poll(() => document.body.textContent?.includes("기록하지 못했어요") || document.body.textContent?.includes("Couldn't record")).toBe(true);
  await expect.element(screen.getByRole("button", { name: /맞아요|Yes/i })).toBeVisible();
});
