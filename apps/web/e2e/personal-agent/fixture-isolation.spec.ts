import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

const apiUrl = requiredLoopbackUrl("MUSE_PERSONAL_AGENT_API_URL");
const stateRoot = resolve(requiredEnvironment("MUSE_PERSONAL_AGENT_STATE_ROOT"));
const noteName = "fixture-proof.md";
const noteContent = "# Personal-agent fixture\n\nPersisted only inside the disposable run.";

test("local-only fixture keeps liveness/readiness and persisted note state isolated", async ({
  page,
  request
}) => {
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

  const liveness = await request.get(`${apiUrl}/health`);
  const readiness = await request.get(`${apiUrl}/ready`);
  expect(liveness.status()).toBe(200);
  expect(await liveness.json()).toMatchObject({ liveness: { status: "up" } });
  expect(readiness.status()).toBe(200);
  expect(await readiness.json()).toMatchObject({
    dependencies: { network: "not-required" },
    readiness: { reasons: [], status: "ready" }
  });

  await page.goto("/");
  await expect(page.getByText("Connected")).toBeVisible();
  await page.getByRole("button", { exact: true, name: "Notes" }).click();
  await page.getByRole("button", { name: "New note" }).click();
  await page.getByPlaceholder("note-name.md").fill(noteName);
  await page.getByPlaceholder("Write in Markdown…").fill(noteContent);
  await page.getByRole("button", { name: "Save" }).click();

  await expect.poll(async () => {
    const response = await request.get(`${apiUrl}/api/notes/read?path=${encodeURIComponent(noteName)}`);
    return response.ok() ? (await response.json()).content : null;
  }).toBe(noteContent);

  await page.reload();
  await page.getByRole("button", { exact: true, name: "Notes" }).click();
  await expect(page.getByText(noteName, { exact: true })).toBeVisible();

  const notePath = resolve(stateRoot, "stores", "notes", noteName);
  expect(notePath.startsWith(`${stateRoot}${sep}`)).toBe(true);
  expect(await readFile(notePath, "utf8")).toBe(noteContent);
  expect(unexpectedEgress).toEqual([]);
});

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredLoopbackUrl(name: string): string {
  const parsed = new URL(requiredEnvironment(name));
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || !parsed.port) {
    throw new Error(`${name} must be loopback-only`);
  }
  return parsed.origin;
}
