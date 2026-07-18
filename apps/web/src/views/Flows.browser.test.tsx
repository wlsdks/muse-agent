import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";

import "../theme.css";

import { FlowsTab } from "./Flows.js";
import { I18nProvider } from "../i18n/index.js";

import type { ApiClient } from "../api/client.js";
import type {
  AutomationProposalsResponse,
  FlowDraftResponse,
  FlowProjection,
  FlowsResponse,
  LoopbackCatalogResponse,
  MessagingSetupResponse,
  ScheduledJobDetail
} from "../api/types.js";

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
  agentSystemPrompt: null,
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
      if (path === "/api/muse/loopback") return LOOPBACK_CATALOG;
      if (path === "/api/messaging/setup") return { providers: [] };
      if (path.startsWith("/api/scheduler/jobs/job_1/executions")) return { items: [], limit: 5, offset: 0, total: 0 };
      throw new Error(`unexpected GET ${path}`);
    }) as unknown as ApiClient["get"],
    patch: vi.fn(async () => ({})) as unknown as ApiClient["patch"],
    post,
    put: vi.fn(async () => ({})) as unknown as ApiClient["put"]
  };
}

/** The create entry point moved into the flow-switcher dropdown (n8n
 * grammar): open the switcher, then click New flow. Uses native clicks —
 * the always-mounted animated menu keeps Playwright's stability waiter
 * spinning even though the button's box never moves. */
async function openCreatePanel(screen: Awaited<ReturnType<typeof renderFlows>>) {
  document.querySelector<HTMLButtonElement>(".flowpick-btn")!.click();
  await expect.poll(() => document.querySelector(".flowpick.open") !== null).toBe(true);
  document.querySelector<HTMLButtonElement>(".flowpick-new")!.click();
  await expect.element(screen.getByRole("textbox", { name: "Name" })).toBeVisible();
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

  await expect.poll(() => document.querySelector(".flowpick-name")?.textContent).toBe("Morning brief");
  await screen.getByText("Schedule trigger", { exact: true }).click();

  const scheduleSelect = screen.getByRole("combobox", { name: "Schedule" });
  await expect.element(scheduleSelect).toBeVisible();
  await scheduleSelect.selectOptions("hourly");

  await screen.getByRole("button", { name: "Save" }).click();

  expect(client.patch).toHaveBeenCalledWith("/api/scheduler/jobs/job_1", { cronExpression: "0 * * * *", timezone: "UTC" });
});

test("changing the trigger timezone PATCHes cronExpression + the chosen timezone", async () => {
  const client = fakeClient();
  const screen = await renderFlows(client);

  await screen.getByText("Schedule trigger", { exact: true }).click();
  const tzSelect = screen.getByRole("combobox", { name: "Timezone" });
  await expect.element(tzSelect).toBeVisible();
  await tzSelect.selectOptions("Asia/Seoul");

  await screen.getByRole("button", { name: "Save" }).click();

  // The job stays on its 0 9 * * * cron but now fires in Seoul, not UTC.
  expect(client.patch).toHaveBeenCalledWith("/api/scheduler/jobs/job_1", { cronExpression: "0 9 * * *", timezone: "Asia/Seoul" });
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
    agentSystemPrompt: null,
    agentPrompt: "오늘 일정 요약해서 보내줘",
    maxRetryCount: 3,
    retryOnFailure: true
  });
});

test("editing the action node's system prompt PATCHes the trimmed agentSystemPrompt", async () => {
  const client = fakeClient();
  const screen = await renderFlows(client);

  await screen.getByText("Agent run", { exact: true }).click();
  const systemPromptField = screen.getByPlaceholder("e.g. You are terse. Always answer in Korean.");
  await expect.element(systemPromptField).toBeVisible();
  await systemPromptField.fill("  You are a terse assistant.  ");

  await screen.getByRole("button", { name: "Save" }).click();

  expect(client.patch).toHaveBeenCalledWith("/api/scheduler/jobs/job_1", {
    agentModel: null,
    agentSystemPrompt: "You are a terse assistant.",
    agentPrompt: "오늘 일정 요약해서 보내줘",
    maxRetryCount: 3,
    retryOnFailure: false
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

  await openCreatePanel(screen);
  await screen.getByRole("textbox", { name: "Name" }).fill("Evening wrap-up");
  await screen.getByRole("textbox", { name: "Prompt", exact: true }).fill("오늘 하루 마무리 정리해줘");

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

test("도구 실행 (Run a tool) flow: New flow -> Run a tool -> pick server+tool -> Create POSTs jobType 'mcp_tool'; a WRITE tool is offered WITH the one-time confirmation banner", async () => {
  const client = fakeClient();
  const screen = await renderFlows(client);

  await openCreatePanel(screen);
  await screen.getByRole("textbox", { name: "Name" }).fill("Time check");
  await screen.getByRole("radio", { name: "Run a tool" }).click();

  const serverSelect = screen.getByRole("combobox", { name: "Tool server" });
  await expect.element(serverSelect).toBeVisible();
  await serverSelect.selectOptions("muse.time");

  const toolSelect = screen.getByRole("combobox", { exact: true, name: "Tool" });
  await toolSelect.selectOptions("now");

  // 진안 2026-07-18 ruling: write tools ARE schedulable (execute never) —
  // picking one surfaces the one-time state-change confirmation banner, and
  // a read pick shows none.
  const toolOptionValues = [...document.querySelectorAll<HTMLOptionElement>("select[aria-label='Tool'] option")].map(
    (option) => option.value
  );
  expect(toolOptionValues).toContain("create_reminder");
  expect(document.querySelector(".write-confirm")).toBeNull();
  await screen.getByRole("combobox", { exact: true, name: "Tool" }).selectOptions("create_reminder");
  await expect.poll(() => document.querySelector(".write-confirm")?.textContent ?? "").toContain("one-time approval");
  await screen.getByRole("combobox", { exact: true, name: "Tool" }).selectOptions("now");
  await expect.poll(() => document.querySelector(".write-confirm")).toBeNull();

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

test("도구 실행 (Run a tool) mode keeps the copilot composer available (it drafts tool flows now)", async () => {
  const client = fakeClient();
  const screen = await renderFlows(client);

  await openCreatePanel(screen);
  await screen.getByRole("radio", { name: "Run a tool" }).click();

  // The composer stays a live chat box in tool mode — no disabled note.
  await expect.element(screen.getByRole("textbox", { name: "Describe an automation" })).toBeVisible();
  expect(document.body.textContent).not.toContain("Draft chat only builds an agent flow for now");
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
      action: "agent",
      cronExpression: "0 9 * * *",
      name: "Morning wrap",
      notifyChannel: "telegram:777",
      prompt: "오늘 하루 요약해줘",
      retry: false,
      toolArguments: {},
      toolName: null,
      toolServer: null
    }
  };
  const post = vi.fn(async (path: string) => (path === "/api/flows/draft" ? draftResponse : {})) as unknown as ApiClient["post"];
  const client = fakeClientWithPost(post);
  const screen = await renderFlows(client);

  // The chat tab now edits the SELECTED flow — creation drafting happens with the create panel open.
  await openCreatePanel(screen);

  await screen.getByRole("textbox", { name: "Describe an automation" }).fill("매일 아침 9시에 하루 요약해줘");
  await screen.getByRole("button", { name: "Draft it" }).click();

  expect(post).toHaveBeenCalledWith("/api/flows/draft", { text: "매일 아침 9시에 하루 요약해줘" });

  await expect.element(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Morning wrap");
  await expect.element(screen.getByRole("textbox", { name: "Prompt", exact: true })).toHaveValue("오늘 하루 요약해줘");
  await expect.element(screen.getByPlaceholder("e.g. telegram:123456")).toHaveValue("telegram:777");
  await expect.element(screen.getByText("Muse's draft", { exact: false })).toBeVisible();

  // Draft-first: opening the prefilled panel must NEVER itself create a job —
  // only the user clicking 만들기 (Create) does that.
  expect(post).not.toHaveBeenCalledWith("/api/scheduler/jobs", expect.anything());
});

test("multi-turn: after drafting, a manual form edit + a follow-up revision turn sends currentDraft reflecting the EDITED form (not the server's last draft), and an ack names the changed field", async () => {
  const firstDraft: FlowDraftResponse = {
    draft: {
      action: "agent",
      cronExpression: "0 9 * * *",
      name: "Morning wrap",
      notifyChannel: null,
      prompt: "오늘 하루 요약해줘",
      retry: false,
      toolArguments: {},
      toolName: null,
      toolServer: null
    }
  };
  const revisedDraft: FlowDraftResponse = {
    draft: {
      action: "agent",
      cronExpression: "30 8 * * *",
      name: "Evening wrap",
      notifyChannel: null,
      prompt: "오늘 하루 요약해줘",
      retry: false,
      toolArguments: {},
      toolName: null,
      toolServer: null
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

  // The chat tab now edits the SELECTED flow — creation drafting happens with the create panel open.
  await openCreatePanel(screen);

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
      action: "agent",
      cronExpression: "0 9 * * *",
      name: "Evening wrap",
      notifyChannel: null,
      prompt: "오늘 하루 요약해줘",
      retry: false,
      toolArguments: {},
      toolName: null,
      toolServer: null
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

  // The chat tab now edits the SELECTED flow — creation drafting happens with the create panel open.
  await openCreatePanel(screen);

  await screen.getByRole("textbox", { name: "Describe an automation" }).fill("아무말이나 던져봐");
  await screen.getByRole("button", { name: "Draft it" }).click();

  await expect.element(screen.getByText(/cronExpression must be a 5-field cron expression/)).toBeVisible();
  await expect.element(screen.getByRole("textbox", { name: "Describe an automation" })).toHaveValue("아무말이나 던져봐");
});

test("the canvas full-screen toggle adds the overlay class, and Escape exits it", async () => {
  const client = fakeClient();
  const screen = await renderFlows(client);
  await expect.poll(() => document.querySelector(".flowpick-name")?.textContent).toBe("Morning brief");

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

test("Duplicate POSTs to the job's duplicate endpoint with the localized name suffix", async () => {
  const client = fakeClient();
  const screen = await renderFlows(client);

  await screen.getByRole("button", { name: "Duplicate" }).click();

  expect(client.post).toHaveBeenCalledWith("/api/scheduler/jobs/job_1/duplicate", { nameSuffix: " (copy)" });
});

test("an invalid custom cron shows the field-error warning and blocks Create", async () => {
  const client = fakeClient();
  const screen = await renderFlows(client);

  await openCreatePanel(screen);
  await screen.getByRole("textbox", { name: "Name" }).fill("Bad cron flow");
  await screen.getByRole("textbox", { name: "Prompt", exact: true }).fill("do it");

  await screen.getByRole("combobox").selectOptions("custom");
  await screen.getByRole("textbox", { name: "Custom cron expression" }).fill("not a cron");

  // The warning renders in the dedicated error class (previously a colorless
  // `var(--err)` inline style), and Create is blocked.
  const warning = screen.getByText("Doesn't look like a valid cron expression (needs 5 fields).");
  await expect.element(warning).toBeVisible();
  expect((warning.query() as HTMLElement | null)?.className).toContain("field-error");
  await expect.element(screen.getByRole("button", { name: "Create" })).toBeDisabled();

  // Correcting the cron clears the warning and unblocks Create.
  await screen.getByRole("textbox", { name: "Custom cron expression" }).fill("0 9 * * *");
  await expect.element(screen.getByRole("button", { name: "Create" })).toBeEnabled();
});

test("invalid tool-arguments JSON shows the field-error warning and blocks Create", async () => {
  const client = fakeClient();
  const screen = await renderFlows(client);

  await openCreatePanel(screen);
  await screen.getByRole("textbox", { name: "Name" }).fill("Bad args flow");
  await screen.getByText("Run a tool", { exact: true }).click();

  const argsField = screen.getByRole("textbox", { name: "Arguments (JSON, optional)" });
  await argsField.fill("{ not json");

  const warning = screen.getByText("Not valid JSON — must be an object, e.g. {}.");
  await expect.element(warning).toBeVisible();
  expect((warning.query() as HTMLElement | null)?.className).toContain("field-error");
  await expect.element(screen.getByRole("button", { name: "Create" })).toBeDisabled();
});

test("a TOOL draft from the copilot prefills the create panel in tool mode (server/tool pickers set)", async () => {
  const toolDraft: FlowDraftResponse = {
    draft: {
      action: "tool",
      cronExpression: "0 * * * *",
      name: "매시간 시각 기록",
      notifyChannel: null,
      prompt: "",
      retry: false,
      toolArguments: {},
      toolName: "now",
      toolServer: "muse.time"
    }
  };
  const post = vi.fn(async (path: string) => (path === "/api/flows/draft" ? toolDraft : {})) as unknown as ApiClient["post"];
  const client = fakeClientWithPost(post);
  const screen = await renderFlows(client);

  // The chat tab now edits the SELECTED flow — creation drafting happens with the create panel open.
  await openCreatePanel(screen);

  await screen.getByRole("textbox", { name: "Describe an automation" }).fill("매시간 정각에 현재 시각 기록해줘");
  await screen.getByRole("button", { name: "Draft it" }).click();

  // The panel opens in tool mode with the drafted pair selected.
  await expect.element(screen.getByRole("textbox", { name: "Name" })).toHaveValue("매시간 시각 기록");
  const toolRadio = document.querySelector<HTMLInputElement>('input[type="radio"][value="tool"], input[type="radio"]:checked');
  const serverSelect = document.querySelector<HTMLSelectElement>("select option[value='muse.time']")?.closest("select");
  await expect.poll(() => serverSelect?.value ?? document.querySelectorAll("select").length).toBeTruthy();
  const selects = [...document.querySelectorAll("select")];
  const serverSel = selects.find((sel) => [...sel.options].some((o) => o.value === "muse.time"));
  expect(serverSel?.value).toBe("muse.time");
  const toolSel = selects.find((sel) => [...sel.options].some((o) => o.value === "now"));
  expect(toolSel?.value).toBe("now");
  expect(toolRadio).not.toBeNull();

  // Draft-first still holds — no job auto-created.
  expect(post).not.toHaveBeenCalledWith("/api/scheduler/jobs", expect.anything());
});

test("a persisted node layout is applied on mount (dragged positions survive reload)", async () => {
  window.localStorage.setItem("muse.flowNodePositions.job_1", JSON.stringify({ "job_1::action": { x: 512, y: 64 } }));
  try {
    const client = fakeClient();
    await renderFlows(client);

    const actionNode = document.querySelector<HTMLElement>('[data-id="job_1::action"]');
    expect(actionNode).not.toBeNull();
    await expect.poll(() => actionNode!.style.transform).toContain("512");
    expect(actionNode!.style.transform).toContain("64");

    // A node with no saved position keeps the default staggered layout.
    const triggerNode = document.querySelector<HTMLElement>('[data-id="job_1::trigger"]');
    await expect.poll(() => triggerNode!.style.transform).toContain("120");
  } finally {
    window.localStorage.removeItem("muse.flowNodePositions.job_1");
  }
});

test("full-workspace (zen) mode sets the root attribute the chrome CSS keys on, and Escape exits", async () => {
  const client = fakeClient();
  const screen = await renderFlows(client);

  const zenBtn = screen.getByRole("button", { name: "Full workspace" });
  await expect.element(zenBtn).toBeVisible();
  document.querySelector<HTMLButtonElement>(".ws-zen-btn")!.click();
  await expect.poll(() => document.documentElement.getAttribute("data-builder-zen")).toBe("true");
  await expect.element(screen.getByRole("button", { name: "Exit full workspace (Esc)" })).toBeVisible();

  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  await expect.poll(() => document.documentElement.getAttribute("data-builder-zen")).toBeNull();
});

test("the Builder consumes Scheduled's one-shot focus hint and opens THAT flow (not the first)", async () => {
  const second: FlowProjection = {
    ...FLOWS_RESPONSE.flows[0]!,
    edges: [],
    id: "job_9",
    name: "Second flow",
    nodes: [
      { id: "job_9::trigger", kind: "trigger.schedule", label: "trigger.schedule", meta: { cronExpression: "0 8 * * *" } },
      { id: "job_9::action", kind: "action.agent", label: "action.agent", meta: { prompt: "second" } },
      { id: "job_9::output", kind: "output.record", label: "output.record", meta: {} }
    ]
  };
  const twoFlows: FlowsResponse = { flows: [FLOWS_RESPONSE.flows[0]!, second] };
  const client = fakeClient();
  (client.get as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
    if (path === "/api/flows") return twoFlows;
    if (path === "/api/scheduler/jobs/job_9") return { ...JOB_DETAIL, id: "job_9", name: "Second flow" };
    if (path === "/api/scheduler/jobs/job_1") return JOB_DETAIL;
    if (path === "/api/muse/loopback") return LOOPBACK_CATALOG;
    if (path === "/api/messaging/setup") return { providers: [] };
    throw new Error(`unexpected GET ${path}`);
  });

  window.sessionStorage.setItem("muse.builderFocusFlow", "job_9");
  try {
    await renderFlows(client);
    await expect.poll(() => document.querySelector(".flowpick-name")?.textContent).toBe("Second flow");
    // one-shot: consumed on mount
    expect(window.sessionStorage.getItem("muse.builderFocusFlow")).toBeNull();
  } finally {
    window.sessionStorage.removeItem("muse.builderFocusFlow");
  }
});

// Chat → Builder handoff (chat-automation-honesty.ts's `builderHint`, the
// "Create in Builder" action on a false-done automation reply): the Builder
// opens the create panel with the copilot composer PRE-FILLED from the
// chat ask — draft-first still holds, the user still presses send.
test("arriving with a copilot seed opens the create panel with the composer PRE-FILLED (draft-first: still requires Send)", async () => {
  const seedText = "매일 아침 9시에 오늘 일정 요약해주는 자동화 만들어줘";
  window.sessionStorage.setItem("muse.builderCopilotSeed", seedText);
  const client = fakeClient();
  try {
    const screen = await renderFlows(client);

    // The panel is ALREADY open (no clicks) — the hint did it, one-shot.
    await expect.element(screen.getByRole("textbox", { name: "Name" })).toBeVisible();
    expect(window.sessionStorage.getItem("muse.builderCopilotSeed")).toBeNull();

    // The copilot composer's textarea carries the seed text already.
    await expect.element(screen.getByRole("textbox", { name: "Describe an automation" })).toHaveValue(seedText);

    // Draft-first: pre-filling never itself drafts or creates anything.
    expect(client.post).not.toHaveBeenCalled();
  } finally {
    window.sessionStorage.removeItem("muse.builderCopilotSeed");
  }
});

test("arriving with a create-for-work hint opens the create panel and auto-links the created flow to that Work", async () => {
  window.sessionStorage.setItem("muse.builderCreateForWork", "work_7");
  const post = vi.fn(async (path: string) => {
    if (path === "/api/scheduler/jobs") return { id: "job_new" };
    return {};
  }) as unknown as ApiClient["post"];
  const client = fakeClientWithPost(post);
  try {
    const screen = await renderFlows(client);

    // The panel is ALREADY open (no clicks) — the hint did it, one-shot.
    await expect.element(screen.getByRole("textbox", { name: "Name" })).toBeVisible();
    expect(window.sessionStorage.getItem("muse.builderCreateForWork")).toBeNull();

    await screen.getByRole("textbox", { name: "Name" }).fill("Work-bound flow");
    await screen.getByRole("textbox", { name: "Prompt", exact: true }).fill("do the work thing");
    await screen.getByRole("button", { name: "Create" }).click();

    // The created flow is linked back to the Work automatically.
    await expect.poll(() => (post as ReturnType<typeof vi.fn>).mock.calls.some(
      ([path, body]) => path === "/api/works/work_7/link"
        && JSON.stringify(body) === JSON.stringify({ id: "job_new", kind: "flow" })
    )).toBe(true);
  } finally {
    window.sessionStorage.removeItem("muse.builderCreateForWork");
  }
});

test("cancelling a Work-bound create panel ends the binding — a later unrelated flow is NOT auto-linked", async () => {
  window.sessionStorage.setItem("muse.builderCreateForWork", "work_7");
  const post = vi.fn(async (path: string) => {
    if (path === "/api/scheduler/jobs") return { id: "job_other" };
    return {};
  }) as unknown as ApiClient["post"];
  const client = fakeClientWithPost(post);
  try {
    const screen = await renderFlows(client);
    await expect.element(screen.getByRole("textbox", { name: "Name" })).toBeVisible();

    // Cancel the Work-bound panel…
    await screen.getByRole("button", { name: "Cancel" }).click();
    // …then manually create an unrelated flow in the SAME session.
    await openCreatePanel(screen);
    await screen.getByRole("textbox", { name: "Name" }).fill("Unrelated flow");
    await screen.getByRole("textbox", { name: "Prompt", exact: true }).fill("unrelated");
    await screen.getByRole("button", { name: "Create" }).click();

    await expect.poll(() => (post as ReturnType<typeof vi.fn>).mock.calls.some(([path]) => path === "/api/scheduler/jobs")).toBe(true);
    expect((post as ReturnType<typeof vi.fn>).mock.calls.some(([path]) => String(path).includes("/api/works/"))).toBe(false);
  } finally {
    window.sessionStorage.removeItem("muse.builderCreateForWork");
  }
});

test("clicking the notify GHOST opens the channel popover and Connect PATCHes the channel", async () => {
  const client = fakeClient();
  const screen = await renderFlows(client);

  await screen.getByText("Connect a notification", { exact: true }).click();
  const popInput = screen.getByPlaceholder("telegram:12345");
  await expect.element(popInput).toBeVisible();
  await popInput.fill("  telegram:777  ");
  await screen.getByRole("button", { name: "Connect", exact: true }).click();

  expect(client.patch).toHaveBeenCalledWith("/api/scheduler/jobs/job_1", { notificationChannelId: "telegram:777" });
});

test("double-clicking the notify edge detaches the channel (PATCH null); structural edges stay inert", async () => {
  const notifyFlow = {
    edges: [
      { from: "job_n::trigger", id: "job_n::edge-trigger-action", to: "job_n::action" },
      { from: "job_n::action", id: "job_n::edge-action-output", to: "job_n::output" }
    ],
    enabled: true,
    id: "job_n",
    name: "Notify flow",
    nextRunAtIso: null,
    nodes: [
      { id: "job_n::trigger", kind: "trigger.schedule", label: "trigger.schedule", meta: { cronExpression: "0 9 * * *", nextRunAtIso: null, timezone: "UTC" } },
      { id: "job_n::action", kind: "action.agent", label: "action.agent", meta: { maxToolCalls: null, model: null, prompt: "요약" } },
      { id: "job_n::output", kind: "output.notify", label: "output.notify", meta: { channelId: "telegram:1" } }
    ],
    source: "scheduler"
  };
  const client = fakeClient();
  (client.get as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
    if (path === "/api/flows") return { flows: [notifyFlow] };
    if (path === "/api/muse/loopback") return LOOPBACK_CATALOG;
    if (path === "/api/messaging/setup") return { providers: [] };
    throw new Error(`unexpected GET ${path}`);
  });
  await renderFlows(client);

  // No ghost on a flow that already has a notify output.
  await expect.poll(() => document.querySelector(".flow-node-ghost")).toBeNull();

  const structural = document.querySelector<SVGGElement>("[data-testid='rf__edge-job_n::edge-trigger-action']");
  structural!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(client.patch).not.toHaveBeenCalled();

  const notifyEdge = document.querySelector<SVGGElement>("[data-testid='rf__edge-job_n::edge-action-output']");
  notifyEdge!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  await expect.poll(() => (client.patch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  expect(client.patch).toHaveBeenCalledWith("/api/scheduler/jobs/job_n", { notificationChannelId: null });
});

test("editing a TOOL node re-points the tool pair via the read-risk cascade and resets args — PATCH carries mcpServerName+toolName+toolArguments", async () => {
  const toolFlow = {
    edges: [
      { from: "job_t::trigger", id: "job_t::edge-trigger-action", to: "job_t::action" }
    ],
    enabled: true,
    id: "job_t",
    name: "Hourly clock",
    nextRunAtIso: null,
    nodes: [
      { id: "job_t::trigger", kind: "trigger.schedule", label: "trigger.schedule", meta: { cronExpression: "0 * * * *", nextRunAtIso: null, timezone: "UTC" } },
      { id: "job_t::action", kind: "action.tool", label: "action.tool", meta: { server: "muse.url", tool: "parse" } }
    ],
    source: "scheduler"
  };
  const toolJobDetail = {
    agentModel: null,
    agentSystemPrompt: null,
    agentPrompt: "",
    cronExpression: "0 * * * *",
    enabled: true,
    id: "job_t",
    jobType: "MCP_TOOL",
    maxRetryCount: 3,
    mcpServerName: "muse.url",
    name: "Hourly clock",
    notificationChannelId: null,
    retryOnFailure: false,
    timezone: "UTC",
    toolArguments: { url: "https://a.com" },
    toolName: "parse"
  };
  const multiServerCatalog = {
    servers: [
      {
        description: "URL utilities.",
        name: "muse.url",
        optIn: false,
        tools: [{ description: "Parses a URL.", name: "parse", risk: "read" }]
      },
      {
        description: "Clock utilities.",
        name: "muse.time",
        optIn: false,
        tools: [
          { description: "Returns the current ISO timestamp.", name: "now", risk: "read" },
          { description: "Millisecond diff.", name: "diff_ms", risk: "read" }
        ]
      }
    ],
    total: 2
  };
  const client = fakeClient();
  (client.get as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
    if (path === "/api/flows") return { flows: [toolFlow] };
    if (path === "/api/scheduler/jobs/job_t") return toolJobDetail;
    if (path === "/api/muse/loopback") return multiServerCatalog;
    if (path === "/api/messaging/setup") return { providers: [] };
    throw new Error(`unexpected GET ${path}`);
  });
  const screen = await renderFlows(client);

  await screen.getByText("Tool call", { exact: true }).click();

  const serverSelect = screen.getByRole("combobox", { name: "Tool server" });
  await expect.element(serverSelect).toBeVisible();
  await serverSelect.selectOptions("muse.time");
  const toolSelect = screen.getByRole("combobox", { name: "Tool", exact: true });
  await toolSelect.selectOptions("now");

  await screen.getByRole("button", { name: "Save" }).click();

  expect(client.patch).toHaveBeenCalledWith("/api/scheduler/jobs/job_t", {
    mcpServerName: "muse.time",
    toolArguments: {},
    toolName: "now"
  });
});

test("a copilot request from a BLANK create panel sends a FRESH turn (no currentDraft) instead of 400ing", async () => {
  const client = fakeClient();
  const screen = await renderFlows(client);

  await openCreatePanel(screen);
  const composerInput = screen.getByPlaceholder("e.g. every morning at 9am, summarize my schedule");
  await composerInput.fill("매일 아침 9시에 일정 요약해서 알려줘");
  await screen.getByRole("button", { name: "Draft it" }).click();

  await expect.poll(() => (client.post as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
  expect(client.post).toHaveBeenCalledWith("/api/flows/draft", {
    text: "매일 아침 9시에 일정 요약해서 알려줘"
  });
});

test("the notify ghost activates from the keyboard (Enter opens the channel popover)", async () => {
  const client = fakeClient();
  await renderFlows(client);

  const ghost = document.querySelector<HTMLElement>(".flow-node-ghost");
  expect(ghost).not.toBeNull();
  expect(ghost!.tabIndex).toBe(0);
  ghost!.focus();
  ghost!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
  await expect.poll(() => document.querySelector(".flow-notify-pop") !== null).toBe(true);
});

test("the Schedule tab lists operational rows and a row name click returns to the canvas focused on that flow", async () => {
  const client = fakeClient();
  const baseGet = client.get as ReturnType<typeof vi.fn>;
  const passthrough = baseGet.getMockImplementation() as (path: string) => Promise<unknown>;
  baseGet.mockImplementation(async (path: string) => {
    if (path === "/api/scheduler/jobs?limit=100") {
      return { items: [{ cadenceSummary: null, id: "job_1", lastRunAt: null, lastStatus: null }] };
    }
    if (path.startsWith("/api/autonomy") || path.startsWith("/api/digest") || path.startsWith("/api/reminders")) {
      return {};
    }
    return await passthrough(path);
  });
  const screen = await renderFlows(client);

  await screen.getByRole("tab", { name: "Schedule" }).click();
  await expect.poll(() => document.querySelector(".sched-name")?.textContent).toBe("Morning brief");

  document.querySelector<HTMLButtonElement>(".sched-name")!.click();
  await expect.poll(() => document.querySelector(".react-flow") !== null).toBe(true);
  await expect.element(screen.getByRole("tab", { name: "Canvas" })).toHaveAttribute("aria-selected", "true");
});

test("Schedule tab: 흐름 초안 열기 on a pattern-proposal card opens the create panel with the composer prefilled", async () => {
  const client = fakeClient();
  const baseGet = client.get as ReturnType<typeof vi.fn>;
  const passthrough = baseGet.getMockImplementation() as (path: string) => Promise<unknown>;
  const proposalsResponse: AutomationProposalsResponse = {
    proposals: [
      {
        category: "time-of-day-action",
        cronExpression: "0 9 * * 1",
        id: "tod-1",
        receipt: { confidence: 0.9, distinctCount: 3, distinctUnit: "days", examples: [], observationCount: 3 },
        suggestionText: "매주 월요일 오전 9시에 저널을 정리하시는군요.",
        title: "월요일 오전 9시 루틴"
      }
    ]
  };
  baseGet.mockImplementation(async (path: string) => {
    if (path === "/api/automation/proposals") return proposalsResponse;
    if (path === "/api/scheduler/jobs?limit=100") {
      return { items: [{ cadenceSummary: null, id: "job_1", lastRunAt: null, lastStatus: null }] };
    }
    if (path.startsWith("/api/autonomy") || path.startsWith("/api/digest") || path.startsWith("/api/reminders")) {
      return {};
    }
    return await passthrough(path);
  });
  const screen = await renderFlows(client);

  await screen.getByRole("tab", { name: "Schedule" }).click();
  await expect.element(screen.getByText("월요일 오전 9시 루틴")).toBeVisible();

  await screen.getByRole("button", { name: "Open flow draft" }).click();

  await expect.element(screen.getByRole("tab", { name: "Canvas" })).toHaveAttribute("aria-selected", "true");
  await expect
    .element(screen.getByLabelText("Describe an automation"))
    .toHaveValue("매주 월요일 오전 9시에 저널을 정리하시는군요.");
});

test("copilot chat: Enter sends, and the thread shows the user bubble + first-draft ack", async () => {
  const client = fakeClient();
  const screen = await renderFlows(client);

  // The chat tab now edits the SELECTED flow — creation drafting happens with the create panel open.
  await openCreatePanel(screen);

  const composer = screen.getByLabelText("Describe an automation");
  await composer.fill("매일 아침 9시에 일정 요약해서 알려줘");
  await composer.click();
  document.querySelector<HTMLTextAreaElement>(".copilot-composer textarea")!
    .dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));

  await expect.poll(() => (client.post as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
  await expect.poll(() => document.querySelectorAll(".chat-bubble.user").length).toBe(1);
  await expect.poll(() => document.querySelectorAll(".chat-bubble.assistant:not(.pending)").length).toBe(1);
});

test("copilot EDIT chat: a revision on the SELECTED flow shows an Apply bar, and Apply PATCHes only the changed fields", async () => {
  const revised = {
    action: "agent",
    cronExpression: "30 8 * * *",
    name: "Morning brief",
    notifyChannel: null,
    prompt: "오늘 일정 요약해서 보내줘",
    retry: false,
    toolArguments: {},
    toolName: null,
    toolServer: null
  };
  const client = fakeClient();
  (client.post as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
    if (path === "/api/flows/draft") return { draft: revised };
    return {};
  });
  const screen = await renderFlows(client);

  const composer = screen.getByLabelText("Describe an automation");
  await composer.fill("8시 반으로 바꿔줘");
  document.querySelector<HTMLTextAreaElement>(".copilot-composer textarea")!
    .dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));

  // the edit turn sends the LIVE job's projection as currentDraft
  await expect.poll(() => (client.post as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  const body = (client.post as ReturnType<typeof vi.fn>).mock.calls[0]![1] as { currentDraft?: { cronExpression: string } };
  expect(body.currentDraft?.cronExpression).toBe("0 9 * * *");

  await screen.getByRole("button", { name: "Apply", exact: true }).click();
  await expect.poll(() => (client.patch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  expect(client.patch).toHaveBeenCalledWith("/api/scheduler/jobs/job_1", { cronExpression: "30 8 * * *" });
});

test("drag-connect handles: visible on the action source and the ghost target, hidden elsewhere", async () => {
  const client = fakeClient();
  await renderFlows(client);

  await expect.poll(() => document.querySelectorAll(".flow-handle").length).toBeGreaterThan(0);
  const actionNode = document.querySelector("[data-id='job_1::action']");
  const actionSource = actionNode?.querySelector(".react-flow__handle-right");
  expect(actionSource?.classList.contains("hidden")).toBe(false);

  const ghostNode = document.querySelector("[data-id='job_1::notify-ghost']");
  const ghostTarget = ghostNode?.querySelector(".react-flow__handle-left");
  expect(ghostTarget?.classList.contains("hidden")).toBe(false);

  const triggerNode = document.querySelector("[data-id='job_1::trigger']");
  const triggerSource = triggerNode?.querySelector(".react-flow__handle-right");
  expect(triggerSource?.classList.contains("hidden")).toBe(true);

  // The functional gate is isValidConnection/classifyConnection (unit
  // matrix) — here we pin the AFFORDANCE: only meaningful endpoints show.
});

test("trigger node detail: webhook section mints a URL, and revoke returns to the enable button", async () => {
  const client = fakeClient();
  let token: string | null = null;
  (client.get as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
    if (path === "/api/flows") return FLOWS_RESPONSE;
    if (path === "/api/scheduler/jobs/job_1") return { ...JOB_DETAIL, webhookTriggerToken: token };
    if (path === "/api/muse/loopback") return LOOPBACK_CATALOG;
    if (path === "/api/messaging/setup") return { providers: [] };
    throw new Error(`unexpected GET ${path}`);
  });
  (client.post as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
    if (path === "/api/scheduler/jobs/job_1/webhook-token") {
      token = "wht_browsertest_000000000000";
      return { token, urlPath: `/api/hooks/flows/${token}` };
    }
    return {};
  });
  (client.del as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
    if (path === "/api/scheduler/jobs/job_1/webhook-token") token = null;
    return undefined;
  });
  const screen = await renderFlows(client);

  await screen.getByText("Schedule trigger", { exact: true }).click();
  await screen.getByRole("button", { name: "Create webhook URL" }).click();
  await expect.poll(() => document.querySelector(".webhook-url")?.textContent ?? "").toContain("wht_browsertest");

  await screen.getByRole("button", { name: "Disable", exact: true }).click();
  await expect.poll(() => document.querySelector(".webhook-url")).toBeNull();
  await expect.element(screen.getByRole("button", { name: "Create webhook URL" })).toBeVisible();
});
