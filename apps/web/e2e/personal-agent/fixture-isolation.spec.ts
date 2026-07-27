import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { reindexNotes } from "../../../../packages/recall/src/notes-index.js";

const apiUrl = requiredLoopbackUrl("MUSE_PERSONAL_AGENT_API_URL");
const embedUrl = requiredLoopbackUrl("MUSE_PERSONAL_AGENT_EMBED_URL");
const stateRoot = resolve(requiredEnvironment("MUSE_PERSONAL_AGENT_STATE_ROOT"));
const embedTrafficFile = resolve(requiredEnvironment("MUSE_PERSONAL_AGENT_EMBED_TRAFFIC_FILE"));
const embedModel = requiredEnvironment("MUSE_EMBED_MODEL");
const noteName = "fixture-proof.md";
const noteContent = "# Personal-agent fixture\n\nThe exact local launch code is ORCHID-742.";
const groundedPrompt = `The exact local launch code is ORCHID-742 [from ${noteName}].`;

test("persisted local note yields a citation-gated answer whose source opens the exact note", async ({
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

  const notesIndexFile = join(stateRoot, "stores", "notes-index.json");
  const reindex = await reindexNotes({
    baseUrlResolver: () => embedUrl,
    dir: resolve(stateRoot, "stores", "notes"),
    force: true,
    indexPath: notesIndexFile,
    model: embedModel
  });
  expect(reindex).toMatchObject({
    embedded: 1,
    failed: 0,
    status: "complete",
    totalChunks: 1,
    totalFiles: 1
  });

  await page.getByLabel("Ask a question grounded in your notes…").fill(groundedPrompt);
  await page.getByRole("button", { exact: true, name: "Ask" }).click();
  await expect(page.getByText("Confident", { exact: true })).toBeVisible();
  await expect(page.getByText("ORCHID-742")).toBeVisible();

  const sourceChip = page.locator(".source-chip").getByText(noteName, { exact: true });
  await expect(sourceChip).toBeVisible();

  await expect.poll(async () => (await readEmbeddingTraffic()).length).toBe(2);
  const embeddingTraffic = await readEmbeddingTraffic();
  expect(embeddingTraffic).toEqual([
    {
      endpoint: `${embedUrl}/api/embeddings`,
      model: embedModel,
      prompt: `[${noteName}] ${noteContent}`
    },
    {
      endpoint: `${embedUrl}/api/embeddings`,
      model: embedModel,
      prompt: groundedPrompt
    }
  ]);

  await sourceChip.click();
  await expect(page.locator(".note-row.active").getByText(noteName, { exact: true })).toBeVisible();
  await expect(page.locator(".note-content")).toHaveText(noteContent);
  expect(unexpectedEgress).toEqual([]);
});

async function readEmbeddingTraffic(): Promise<readonly {
  readonly endpoint: string;
  readonly model: string;
  readonly prompt: string;
}[]> {
  try {
    const raw = await readFile(embedTrafficFile, "utf8");
    return raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

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
