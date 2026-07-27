import { expect, test, type Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TASK_ADD_OBSERVATION_SCHEMA,
  projectTaskAddObservation
} from "../../../../scripts/lib/task-add-parity-contract.mjs";

const apiUrl = requiredLoopbackUrl("MUSE_PERSONAL_AGENT_API_URL");
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const stateRoot = resolve(requiredEnvironment("MUSE_PERSONAL_AGENT_STATE_ROOT"));
const tasksFile = resolve(requiredEnvironment("MUSE_TASKS_FILE"));
const taskTitle = "Task047 surface parity";
const emptyTaskStore = '{\n  "tasks": []\n}\n';

test("CLI-local, direct API, and real Web task add share one verified parity contract", async ({
  page,
  request
}) => {
  expect(tasksFile).toBe(join(stateRoot, "stores", "tasks.json"));
  expect(tasksFile.startsWith(`${stateRoot}${sep}`)).toBe(true);

  const unexpectedEgress: string[] = [];
  page.on("request", (outbound) => {
    const url = new URL(outbound.url());
    if ((url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "127.0.0.1") {
      unexpectedEgress.push(url.origin);
    }
  });
  await page.addInitScript((ownedApiUrl) => {
    window.localStorage.setItem("muse.apiUrl", ownedApiUrl);
    window.localStorage.setItem("muse.lang", "en");
    window.localStorage.removeItem("muse.token");
  }, apiUrl);

  const observations = [];

  const cliSuccessBefore = await resetAndVerifyEmptyStore("cli-local success");
  const cliSuccess = await runSourceCli([
    "tasks",
    "add",
    taskTitle,
    "--local",
    "--json"
  ]);
  expect(cliSuccess).toMatchObject({ code: 0, signal: null, stderr: "" });
  const cliSuccessTask = parseJsonObject(cliSuccess.stdout, "CLI success stdout");
  const cliSuccessAfter = await readTaskStore();
  expect(cliSuccessAfter).toEqual([cliSuccessTask]);
  observations.push({
    afterStore: cliSuccessAfter,
    allowedEffectCount: cliSuccessAfter.length - cliSuccessBefore.length,
    beforeStore: cliSuccessBefore,
    resultTask: cliSuccessTask,
    scenario: "success",
    schemaVersion: TASK_ADD_OBSERVATION_SCHEMA,
    surface: "cli-local",
    terminal: { exitCode: cliSuccess.code, kind: "cli", signal: cliSuccess.signal }
  });

  const cliErrorBefore = await resetAndVerifyEmptyStore("cli-local empty-title");
  const cliError = await runSourceCli(["tasks", "add", "--local", "--json"]);
  expect(cliError).toMatchObject({ code: 2, signal: null, stderr: "" });
  expect(parseJsonObject(cliError.stdout, "CLI empty-title stdout")).toMatchObject({
    error: { code: "commander.missingArgument" },
    exitCode: 2,
    ok: false,
    terminalState: "user-error"
  });
  const cliErrorAfter = await readTaskStore();
  observations.push({
    afterStore: cliErrorAfter,
    allowedEffectCount: cliErrorAfter.length - cliErrorBefore.length,
    beforeStore: cliErrorBefore,
    resultTask: null,
    scenario: "empty-title",
    schemaVersion: TASK_ADD_OBSERVATION_SCHEMA,
    surface: "cli-local",
    terminal: { exitCode: cliError.code, kind: "cli", signal: cliError.signal }
  });

  const apiSuccessBefore = await resetAndVerifyEmptyStore("API success");
  const apiSuccess = await request.post(`${apiUrl}/api/tasks`, { data: { title: taskTitle } });
  expect(apiSuccess.status()).toBe(201);
  const apiSuccessTask = parseUnknownObject(await apiSuccess.json(), "API success response");
  const apiSuccessAfter = await readTaskStore();
  expect(apiSuccessAfter).toEqual([apiSuccessTask]);
  observations.push({
    afterStore: apiSuccessAfter,
    allowedEffectCount: apiSuccessAfter.length - apiSuccessBefore.length,
    beforeStore: apiSuccessBefore,
    resultTask: apiSuccessTask,
    scenario: "success",
    schemaVersion: TASK_ADD_OBSERVATION_SCHEMA,
    surface: "api",
    terminal: { kind: "http", statusCode: apiSuccess.status() }
  });

  const apiErrorBefore = await resetAndVerifyEmptyStore("API empty-title");
  const apiError = await request.post(`${apiUrl}/api/tasks`, { data: { title: "   " } });
  expect(apiError.status()).toBe(400);
  expect(await apiError.json()).toEqual({
    code: "INVALID_TASK",
    message: "title must be a non-empty string"
  });
  const apiErrorAfter = await readTaskStore();
  observations.push({
    afterStore: apiErrorAfter,
    allowedEffectCount: apiErrorAfter.length - apiErrorBefore.length,
    beforeStore: apiErrorBefore,
    resultTask: null,
    scenario: "empty-title",
    schemaVersion: TASK_ADD_OBSERVATION_SCHEMA,
    surface: "api",
    terminal: { kind: "http", statusCode: apiError.status() }
  });

  const webSuccessBefore = await resetAndVerifyEmptyStore("Web success");
  await openTasksView(page);
  let webSuccessPostCount = 0;
  const countWebSuccessPost = (outbound: { method(): string; url(): string }) => {
    if (isTaskAddRequest(outbound)) webSuccessPostCount += 1;
  };
  page.on("request", countWebSuccessPost);
  const titleInput = page.getByLabel("Add a task and press Enter…");
  const addButton = page.getByRole("main").getByRole("button", { exact: true, name: "Add" });
  await titleInput.fill(taskTitle);
  await expect(addButton).toBeEnabled();
  const webSubmitEnabled = await addButton.isEnabled();
  const webResponsePromise = page.waitForResponse((response) =>
    isTaskAddRequest(response.request())
  );
  await addButton.click();
  const webResponse = await webResponsePromise;
  expect(webResponse.status()).toBe(201);
  const webSuccessTask = parseUnknownObject(await webResponse.json(), "Web success response");
  await expect(page.getByText(taskTitle, { exact: true })).toBeVisible();
  await expect.poll(async () => (await readTaskStore()).length).toBe(1);
  const webSuccessAfter = await readTaskStore();
  page.off("request", countWebSuccessPost);
  expect(webSuccessAfter).toEqual([webSuccessTask]);
  observations.push({
    afterStore: webSuccessAfter,
    allowedEffectCount: webSuccessAfter.length - webSuccessBefore.length,
    beforeStore: webSuccessBefore,
    resultTask: webSuccessTask,
    scenario: "success",
    schemaVersion: TASK_ADD_OBSERVATION_SCHEMA,
    surface: "web",
    terminal: {
      kind: "ui",
      requestCount: webSuccessPostCount,
      submitEnabled: webSubmitEnabled
    }
  });

  const webErrorBefore = await resetAndVerifyEmptyStore("Web empty-title");
  await openTasksView(page);
  let webErrorPostCount = 0;
  const countWebErrorPost = (outbound: { method(): string; url(): string }) => {
    if (isTaskAddRequest(outbound)) webErrorPostCount += 1;
  };
  page.on("request", countWebErrorPost);
  const blankTitleInput = page.getByLabel("Add a task and press Enter…");
  const disabledAddButton = page.getByRole("main").getByRole("button", {
    exact: true,
    name: "Add"
  });
  await blankTitleInput.fill("   ");
  await expect(disabledAddButton).toBeDisabled();
  const webErrorSubmitEnabled = await disabledAddButton.isEnabled();
  await expect(page.getByText(taskTitle, { exact: true })).toHaveCount(0);
  const webErrorAfter = await readTaskStore();
  page.off("request", countWebErrorPost);
  observations.push({
    afterStore: webErrorAfter,
    allowedEffectCount: webErrorAfter.length - webErrorBefore.length,
    beforeStore: webErrorBefore,
    resultTask: null,
    scenario: "empty-title",
    schemaVersion: TASK_ADD_OBSERVATION_SCHEMA,
    surface: "web",
    terminal: {
      kind: "ui",
      requestCount: webErrorPostCount,
      submitEnabled: webErrorSubmitEnabled
    }
  });

  const projections = observations.map((observation) =>
    projectTaskAddObservation(observation)
  );
  const successProjections = projections.filter((projection) => projection.scenario === "success");
  const errorProjections = projections.filter((projection) => projection.scenario === "empty-title");
  expect(successProjections).toHaveLength(3);
  expect(errorProjections).toHaveLength(3);
  for (const projection of successProjections) {
    expect(projection).toMatchObject({
      allowedEffectCount: 1,
      reason: "task-added",
      terminal: "success",
      verification: "verified"
    });
  }
  for (const projection of errorProjections) {
    expect(projection).toMatchObject({
      allowedEffectCount: 0,
      reason: "empty-title",
      terminal: "user-error",
      verification: "verified"
    });
    expect(projection.beforeStoreDigest).toBe(projection.storeDigest);
  }
  expect(new Set(successProjections.map((projection) => projection.parityDigest)).size).toBe(1);
  expect(new Set(errorProjections.map((projection) => projection.parityDigest)).size).toBe(1);
  expect(unexpectedEgress).toEqual([]);
});

async function resetAndVerifyEmptyStore(label: string): Promise<readonly Record<string, unknown>[]> {
  await writeFile(tasksFile, emptyTaskStore, "utf8");
  expect(await readFile(tasksFile, "utf8"), `${label}: exact empty bytes`).toBe(emptyTaskStore);
  const tasks = await readTaskStore();
  expect(tasks, `${label}: empty task array`).toEqual([]);
  return tasks;
}

async function readTaskStore(): Promise<readonly Record<string, unknown>[]> {
  const document: unknown = JSON.parse(await readFile(tasksFile, "utf8"));
  if (
    document === null
    || typeof document !== "object"
    || Array.isArray(document)
    || !Array.isArray((document as { readonly tasks?: unknown }).tasks)
  ) {
    throw new TypeError("MUSE_TASKS_FILE must contain an object with a tasks array");
  }
  return (document as { readonly tasks: readonly unknown[] }).tasks.map((task, index) =>
    parseUnknownObject(task, `MUSE_TASKS_FILE task ${index.toString()}`)
  );
}

async function runSourceCli(args: readonly string[]): Promise<{
  readonly code: number;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
}> {
  return await new Promise((resolveCli, rejectCli) => {
    const child = spawn(
      "pnpm",
      ["--silent", "--filter", "@muse/cli", "dev", ...args],
      {
        cwd: rootDir,
        detached: false,
        env: { ...process.env, MUSE_TASKS_FILE: tasksFile },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    let stderr = "";
    let stdout = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      rejectCli(new Error(`source CLI timed out: ${args.join(" ")}`));
    }, 60_000);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectCli(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === null) {
        rejectCli(new Error(`source CLI had no exit code (signal=${String(signal)})`));
        return;
      }
      resolveCli({ code, signal, stderr, stdout });
    });
  });
}

async function openTasksView(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByText("Connected")).toBeVisible();
  await page.getByRole("button", { exact: true, name: "Tasks" }).click();
  await expect(page.getByRole("heading", { exact: true, name: "Tasks" })).toBeVisible();
  await expect(page.locator(".card-head .count")).toHaveText("0");
}

function isTaskAddRequest(request: { method(): string; url(): string }): boolean {
  const url = new URL(request.url());
  return request.method() === "POST"
    && url.hostname === "127.0.0.1"
    && url.pathname === "/api/tasks";
}

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  return parseUnknownObject(JSON.parse(raw), label);
}

function parseUnknownObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set by the owned personal-agent E2E runner`);
  return value;
}

function requiredLoopbackUrl(name: string): string {
  const value = requiredEnvironment(name);
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || !parsed.port) {
    throw new Error(`${name} must be an explicit http://127.0.0.1:<port> URL`);
  }
  return parsed.origin;
}
