import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";

import "../theme.css";

import { FlowsTab } from "./Flows.js";
import { I18nProvider } from "../i18n/index.js";

import type { ApiClient } from "../api/client.js";
import type { FlowDraftResponse, FlowsResponse, LoopbackCatalogResponse, MessagingSetupResponse, ScheduledJobDetail } from "../api/types.js";

// No global setup file registers `cleanup()` for this project's browser
// config yet, so each test must unmount its own tree — several tests in
// this file mount `ReactFlowProvider` (its own internal store per mount),
// and leaving a prior mount's tree in the DOM across tests corrupts the
// next mount's React dispatcher state.
afterEach(cleanup);

// The default test iframe is narrow enough that React Flow's `fitView` on a
// 3-node-wide (0/340/680px) canvas zooms/pans so only ONE node's bounding
// box sits inside the `overflow: hidden` wrapper at a time — a real desktop
// window doesn't hit this. Widen the viewport so every node is genuinely
// visible and clickable, matching how a user actually sees the canvas.
beforeEach(async () => {
  await page.viewport(1280, 800);
});

// A real-browser interaction suite: clicking a canvas node, filling a form,
// and saving only actually happens client-side after mount — SSR
// (`Flows.test.tsx`) can't exercise it. Every assertion here checks the
// EXACT method + url + body the fake `ApiClient` received, proving the UI
// compiles to the same payload `flow-edit-compile.ts`'s unit tests expect.

const FLOWS_RESPONSE: FlowsResponse = {
  flows: [
    {
      edges: [
        { from: "job_1::trigger", id: "job_1::edge-trigger-action", to: "job_1::action" },
        { from: "job_1::action", id: "job_1::edge-action-output", to: "job_1::output" }
      ],
      enabled: true,
      id: "job_1",
      name: "Morning brief",
      nextRunAtIso: "2026-07-18T09:00:00.000Z",
      nodes: [
        {
          id: "job_1::trigger",
          kind: "trigger.schedule",
          label: "trigger.schedule",
          meta: { cronExpression: "0 9 * * *", nextRunAtIso: "2026-07-18T09:00:00.000Z", timezone: "UTC" }
        },
        {
          id: "job_1::action",
          kind: "action.agent",
          label: "action.agent",
          meta: { maxToolCalls: null, model: null, prompt: "오늘 일정 요약해서 보내줘" }
        },
        { id: "job_1::output", kind: "output.record", label: "output.record", meta: {} }
      ],
      source: "scheduler"
    }
  ]
};

const JOB_DETAIL: ScheduledJobDetail = {
  agentModel: null,
  agentPrompt: "오늘 일정 요약해서 보내줘",
  cronExpression: "0 9 * * *",
  enabled: true,
  id: "job_1",
  jobType: "AGENT",
  maxRetryCount: 3,
  name: "Morning brief",
  notificationChannelId: null,
  retryOnFailure: false,
  timezone: "UTC"
};

const LOOPBACK_CATALOG: LoopbackCatalogResponse = {
  servers: [
    {
      description: "Built-in clock and date utilities.",
      name: "muse.time",
      optIn: false,
      tools: [
        { description: "Returns the current ISO timestamp.", name: "now", risk: "read" },
        { description: "Create a reminder.", name: "create_reminder", risk: "write" }
      ]
    }
  ],
  total: 1
};

function fakeClient(): ApiClient {
  return {
    baseUrl: "http://fake.invalid",
    del: vi.fn(async () => undefined) as unknown as ApiClient["del"],
    get: vi.fn(async (path: string) => {
      if (path === "/api/flows") return FLOWS_RESPONSE;
      if (path === "/api/scheduler/jobs/job_1") return JOB_DETAIL;
      if (path === "/api/muse/loopback") return LOOPBACK_CATALOG;
      if (path === "/api/messaging/setup") return { providers: [] };
      throw new Error(`unexpected GET ${path}`);
    }) as unknown as ApiClient["get"],
    patch: vi.fn(async () => ({})) as unknown as ApiClient["patch"],
    post: vi.fn(async () => ({})) as unknown as ApiClient["post"],
    put: vi.fn(async () => ({})) as unknown as ApiClient["put"]
  };
}

const PAIRED_SETUP: MessagingSetupResponse = {
  providers: [
    {
      configured: true,
      displayName: "Telegram",
      docsUrl: "https://example.invalid",
      id: "telegram",
      pairedOwner: "424242",
      registered: true,
      source: "file"
    },
    {
      configured: true,
      displayName: "Discord",
      docsUrl: "https://example.invalid",
      id: "discord",
      registered: false,
      source: "file"
    }
  ]
};

function fakeClientWithChannels(): ApiClient {
  const client = fakeClient();
  (client.get as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
    if (path === "/api/flows") return FLOWS_RESPONSE;
    if (path === "/api/scheduler/jobs/job_1") return JOB_DETAIL;
    if (path === "/api/muse/loopback") return LOOPBACK_CATALOG;
    if (path === "/api/messaging/setup") return PAIRED_SETUP;
    throw new Error(`unexpected GET ${path}`);
  });
  return client;
}

/** Same shape as `fakeClient()` but with an injectable `post` — the 코파일럿
 * 초안 tests need a `POST /api/flows/draft` response/rejection distinct from
 * every other mutation this view fires. */
function fakeClientWithPost(post: ApiClient["post"]): ApiClient {
  return {
    baseUrl: "http://fake.invalid",
    del: vi.fn(async () => undefined) as unknown as ApiClient["del"],
    get: vi.fn(async (path: string) => {
      if (path === "/api/flows") return FLOWS_RESPONSE;
      if (path === "/api/scheduler/jobs/job_1") return JOB_DETAIL;
      if (path.startsWith("/api/scheduler/jobs/job_1/executions")) return { items: [], limit: 5, offset: 0, total: 0 };
      throw new Error(`unexpected GET ${path}`);
    }) as unknown as ApiClient["get"],
    patch: vi.fn(async () => ({})) as unknown as ApiClient["patch"],
    post,
    put: vi.fn(async () => ({})) as unknown as ApiClient["put"]
  };
}

async function renderFlows(client: ApiClient) {
  window.localStorage.setItem("muse.lang", "en");
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <FlowsTab client={client} />
      </I18nProvider>
    </QueryClientProvider>
  );
  // React Flow only paints its nodes once it has measured a real (non-zero)
  // container via ResizeObserver — on a cold first render in this suite that
  // measurement can land after the default assertion retry window, so poll
  // for the real canvas node count explicitly before any node interaction.
  await expect.poll(() => document.querySelectorAll(".react-flow__node").length, { timeout: 10000 }).toBeGreaterThan(0);
  return screen;
}

test("selecting the trigger node and choosing a new preset PATCHes exactly the resolved cron", async () => {
  const client = fakeClient();
  const screen = await renderFlows(client);

  await expect.element(screen.getByRole("heading", { name: "Morning brief" })).toBeVisible();
  await screen.getByText("Schedule trigger", { exact: true }).click();

  const scheduleSelect = screen.getByRole("combobox");
  await expect.element(scheduleSelect).toBeVisible();
  await scheduleSelect.selectOptions("hourly");

  await screen.getByRole("button", { name: "Save" }).click();

  expect(client.patch).toHaveBeenCalledWith("/api/scheduler/jobs/job_1", { cronExpression: "0 * * * *" });
});

test("toggling retry on the action node PATCHes retryOnFailure + a real maxRetryCount, prompt/model unchanged", async () => {
  const client = fakeClient();
  const screen = await renderFlows(client);

  await screen.getByText("Agent run", { exact: true }).click();
  const retryCheckbox = screen.getByRole("checkbox");
  await expect.element(retryCheckbox).toBeVisible();
  await retryCheckbox.click();

  await screen.getByRole("button", { name: "Save" }).click();

  expect(client.patch).toHaveBeenCalledWith("/api/scheduler/jobs/job_1", {
    agentModel: null,
    agentPrompt: "오늘 일정 요약해서 보내줘",
    maxRetryCount: 3,
    retryOnFailure: true
  });
});

test("setting a notify channel on the output node PATCHes the trimmed channel id", async () => {
  const client = fakeClient();
  const screen = await renderFlows(client);

  await screen.getByText("Execution record", { exact: true }).click();
  // The 코파일럿 초안 composer's input is now ALSO a textbox on this screen
  // (Flows list card), so a bare `getByRole("textbox")` is no longer unique —
  // scope by placeholder to the notify-channel field specifically.
  const channelInput = screen.getByPlaceholder("e.g. telegram:123456");
  await expect.element(channelInput).toBeVisible();
  await channelInput.fill("telegram:999");

  await screen.getByRole("button", { name: "Save" }).click();

  expect(client.patch).toHaveBeenCalledWith("/api/scheduler/jobs/job_1", { notificationChannelId: "telegram:999" });
});

test("'Run now' POSTs to the job's trigger endpoint with no body", async () => {
  const client = fakeClient();
  const screen = await renderFlows(client);

  await screen.getByRole("button", { name: "Run now" }).click();

  expect(client.post).toHaveBeenCalledWith("/api/scheduler/jobs/job_1/trigger");
});

test("Delete requires two clicks — the first only arms a 4s confirm window, the second actually DELETEs", async () => {
  const client = fakeClient();
  const screen = await renderFlows(client);

  await screen.getByRole("button", { name: "Delete" }).click();
  expect(client.del).not.toHaveBeenCalled();

  await screen.getByRole("button", { name: "Really delete?" }).click();
  expect(client.del).toHaveBeenCalledWith("/api/scheduler/jobs/job_1");
});

test("새 흐름 만들기 (New flow) POSTs the exact compiled create body", async () => {
  const client = fakeClient();
  const screen = await renderFlows(client);

  await screen.getByRole("button", { name: "New flow" }).click();
  await screen.getByRole("textbox", { name: "Name" }).fill("Evening wrap-up");
  await screen.getByRole("textbox", { name: "Prompt" }).fill("오늘 하루 마무리 정리해줘");

  await screen.getByRole("button", { name: "Create" }).click();

  expect(client.post).toHaveBeenCalledWith("/api/scheduler/jobs", {
    agentPrompt: "오늘 하루 마무리 정리해줘",
    cronExpression: "0 9 * * *",
    enabled: true,
    jobType: "agent",
    maxRetryCount: 3,
    name: "Evening wrap-up",
    retryOnFailure: false,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
  });
});

test("도구 실행 (Run a tool) flow: New flow -> Run a tool -> pick server+tool -> Create POSTs jobType 'mcp_tool', write tools never offered", async () => {
  const client = fakeClient();
  const screen = await renderFlows(client);

  await screen.getByRole("button", { name: "New flow" }).click();
  await screen.getByRole("textbox", { name: "Name" }).fill("Time check");
  await screen.getByRole("radio", { name: "Run a tool" }).click();

  const serverSelect = screen.getByRole("combobox", { name: "Tool server" });
  await expect.element(serverSelect).toBeVisible();
  await serverSelect.selectOptions("muse.time");

  const toolSelect = screen.getByRole("combobox", { exact: true, name: "Tool" });
  await toolSelect.selectOptions("now");

  // The write-risk tool in the fixture (create_reminder) must never appear —
  // the picker is fail-closed to risk: "read" only.
  const toolOptionValues = [...document.querySelectorAll<HTMLOptionElement>("select[aria-label='Tool'] option")].map(
    (option) => option.value
  );
  expect(toolOptionValues).not.toContain("create_reminder");

  await screen.getByRole("button", { name: "Create" }).click();

  expect(client.post).toHaveBeenCalledWith("/api/scheduler/jobs", {
    cronExpression: "0 9 * * *",
    enabled: true,
    jobType: "mcp_tool",
    maxRetryCount: 3,
    mcpServerName: "muse.time",
    name: "Time check",
    retryOnFailure: false,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    toolArguments: {},
    toolName: "now"
  });
});

test("도구 실행 (Run a tool) mode disables the copilot composer with an honest note instead of a chat box", async () => {
  const client = fakeClient();
  const screen = await renderFlows(client);

  await screen.getByRole("button", { name: "New flow" }).click();
  await screen.getByRole("radio", { name: "Run a tool" }).click();

  await expect.element(screen.getByText("Draft chat only builds an agent flow for now", { exact: false })).toBeVisible();
  expect(document.querySelector("[aria-label='Describe an automation']")).toBeNull();
});

test("'Test run' POSTs to the job's dry-run endpoint with no body", async () => {
  const client = fakeClient();
  const screen = await renderFlows(client);

  await screen.getByRole("button", { name: "Test run" }).click();

  expect(client.post).toHaveBeenCalledWith("/api/scheduler/jobs/job_1/dry-run");
});

test("초안 그리기 (Draft it) opens the create panel PREFILLED from the parsed draft, and never auto-creates a job", async () => {
  const draftResponse: FlowDraftResponse = {
    draft: {
      cronExpression: "0 9 * * *",
      name: "Morning wrap",
      notifyChannel: "telegram:777",
      prompt: "오늘 하루 요약해줘",
      retry: false
    }
  };
  const post = vi.fn(async (path: string) => (path === "/api/flows/draft" ? draftResponse : {})) as unknown as ApiClient["post"];
  const client = fakeClientWithPost(post);
  const screen = await renderFlows(client);

  await screen.getByRole("textbox", { name: "Describe an automation" }).fill("매일 아침 9시에 하루 요약해줘");
  await screen.getByRole("button", { name: "Draft it" }).click();

  expect(post).toHaveBeenCalledWith("/api/flows/draft", { text: "매일 아침 9시에 하루 요약해줘" });

  await expect.element(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Morning wrap");
  await expect.element(screen.getByRole("textbox", { name: "Prompt" })).toHaveValue("오늘 하루 요약해줘");
  await expect.element(screen.getByPlaceholder("e.g. telegram:123456")).toHaveValue("telegram:777");
  await expect.element(screen.getByText("Muse's draft", { exact: false })).toBeVisible();

  // Draft-first: opening the prefilled panel must NEVER itself create a job —
  // only the user clicking 만들기 (Create) does that.
  expect(post).not.toHaveBeenCalledWith("/api/scheduler/jobs", expect.anything());
});

test("multi-turn: after drafting, a manual form edit + a follow-up revision turn sends currentDraft reflecting the EDITED form (not the server's last draft), and an ack names the changed field", async () => {
  const firstDraft: FlowDraftResponse = {
    draft: {
      cronExpression: "0 9 * * *",
      name: "Morning wrap",
      notifyChannel: null,
      prompt: "오늘 하루 요약해줘",
      retry: false
    }
  };
  const revisedDraft: FlowDraftResponse = {
    draft: {
      cronExpression: "30 8 * * *",
      name: "Evening wrap",
      notifyChannel: null,
      prompt: "오늘 하루 요약해줘",
      retry: false
    }
  };
  const post = vi.fn(async (path: string, body?: unknown) => {
    if (path === "/api/flows/draft") {
      // The FIRST call has no currentDraft; the SECOND (revision) call must
      // carry the manually-edited form values, not the first draft's name.
      return (body as { currentDraft?: unknown } | undefined)?.currentDraft ? revisedDraft : firstDraft;
    }
    return {};
  }) as unknown as ApiClient["post"];
  const client = fakeClientWithPost(post);
  const screen = await renderFlows(client);

  await screen.getByRole("textbox", { name: "Describe an automation" }).fill("매일 아침 9시에 하루 요약해줘");
  await screen.getByRole("button", { name: "Draft it" }).click();

  await expect.element(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Morning wrap");

  // A manual edit to the form BETWEEN turns — the next revision must reflect
  // this, not the server's original draft.
  await screen.getByRole("textbox", { name: "Name" }).fill("Evening wrap");

  await expect.element(screen.getByPlaceholder("Keep talking — e.g. change it to 8:30")).toBeVisible();
  await screen.getByRole("textbox", { name: "Describe an automation" }).fill("8시 반으로 바꿔줘");
  await screen.getByRole("button", { name: "Send" }).click();

  await expect.element(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Evening wrap");

  expect(post).toHaveBeenCalledWith("/api/flows/draft", {
    currentDraft: {
      cronExpression: "0 9 * * *",
      name: "Evening wrap",
      notifyChannel: null,
      prompt: "오늘 하루 요약해줘",
      retry: false
    },
    text: "8시 반으로 바꿔줘"
  });

  // The ack names the field that actually changed (Schedule/cron), not name
  // (the manual edit) since the model's revision didn't touch it again.
  await expect.element(screen.getByText("Draft updated", { exact: false })).toBeVisible();
  await expect.element(screen.getByText(/Schedule:.*30 8 \* \* \*/)).toBeVisible();

  // Draft-first still holds across every turn: no job is ever auto-created.
  expect(post).not.toHaveBeenCalledWith("/api/scheduler/jobs", expect.anything());
});

test("a 422 draft failure shows the reason verbatim and keeps the typed text", async () => {
  const post = vi.fn(async (path: string) => {
    if (path === "/api/flows/draft") {
      throw new Error("422: cronExpression must be a 5-field cron expression (minute hour day month weekday)");
    }
    return {};
  }) as unknown as ApiClient["post"];
  const client = fakeClientWithPost(post);
  const screen = await renderFlows(client);

  await screen.getByRole("textbox", { name: "Describe an automation" }).fill("아무말이나 던져봐");
  await screen.getByRole("button", { name: "Draft it" }).click();

  await expect.element(screen.getByText(/cronExpression must be a 5-field cron expression/)).toBeVisible();
  await expect.element(screen.getByRole("textbox", { name: "Describe an automation" })).toHaveValue("아무말이나 던져봐");
});

test("the canvas full-screen toggle adds the overlay class, and Escape exits it", async () => {
  const client = fakeClient();
  const screen = await renderFlows(client);
  await expect.element(screen.getByRole("heading", { name: "Morning brief" })).toBeVisible();

  const wrap = document.querySelector(".flow-canvas-wrap");
  expect(wrap).not.toBeNull();
  expect(wrap!.classList.contains("flow-canvas-fullscreen")).toBe(false);

  // Enter full screen — the button carries the enter label; the wrap becomes
  // the fixed overlay.
  await screen.getByRole("button", { name: "Full screen" }).click();
  await expect.poll(() => wrap!.classList.contains("flow-canvas-fullscreen")).toBe(true);

  // The same control now offers the exit affordance...
  await expect.element(screen.getByRole("button", { name: "Exit full screen" })).toBeVisible();

  // ...and Escape leaves full screen without any click (the handler listens
  // on window, which is where a real keypress with no focused input lands).
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  await expect.poll(() => wrap!.classList.contains("flow-canvas-fullscreen")).toBe(false);
});

test("the notify picker offers only deliverable channels and fills the resolved provider:destination", async () => {
  const client = fakeClientWithChannels();
  const screen = await renderFlows(client);

  await screen.getByText("Execution record", { exact: true }).click();

  // The picker appears (paired Telegram is deliverable); the raw text field
  // stays alongside it.
  const picker = screen.getByRole("combobox", { name: "Pick from connected channels" });
  await expect.element(picker).toBeVisible();

  // Discord is registered:false → not deliverable → never offered.
  const pickerEl = document.querySelector<HTMLSelectElement>('select[aria-label="Pick from connected channels"]');
  const optionLabels = [...(pickerEl?.options ?? [])].map((o) => o.textContent);
  expect(optionLabels.some((l) => l?.includes("Telegram"))).toBe(true);
  expect(optionLabels.some((l) => l?.includes("Discord"))).toBe(false);

  // Selecting the channel fills the exact provider:destination value.
  await picker.selectOptions("telegram:424242");
  const channelInput = screen.getByPlaceholder("e.g. telegram:123456");
  await expect.element(channelInput).toHaveValue("telegram:424242");

  await screen.getByRole("button", { name: "Save" }).click();
  expect(client.patch).toHaveBeenCalledWith("/api/scheduler/jobs/job_1", { notificationChannelId: "telegram:424242" });
});
