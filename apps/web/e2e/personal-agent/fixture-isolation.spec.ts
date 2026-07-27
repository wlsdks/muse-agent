import { expect, test, type APIRequestContext } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { reindexNotes } from "../../../../packages/recall/src/notes-index.js";

const apiUrl = requiredLoopbackUrl("MUSE_PERSONAL_AGENT_API_URL");
const embedUrl = requiredLoopbackUrl("MUSE_PERSONAL_AGENT_EMBED_URL");
const stateRoot = resolve(requiredEnvironment("MUSE_PERSONAL_AGENT_STATE_ROOT"));
const embedTrafficFile = resolve(requiredEnvironment("MUSE_PERSONAL_AGENT_EMBED_TRAFFIC_FILE"));
const embedModel = requiredEnvironment("MUSE_EMBED_MODEL");
const noteName = "fixture-proof.md";
const noteContent = "The exact local launch code is ORCHID-742.";
const groundedPrompt = `The exact local launch code is ORCHID-742 [from ${noteName}].`;
const threadTitle = "Resume the fixture launch";

test("persisted note grounds Ask and an explicit Continuity Pack records one confirmed outcome", async ({
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

  await page.getByRole("button", { exact: true, name: "Continuity" }).click();
  await expect(page.getByRole("heading", { exact: true, name: "Continuity review" })).toBeVisible();
  await page.getByPlaceholder("What do you want to resume?").fill(threadTitle);
  await page.getByRole("main").getByRole("button", { exact: true, name: "Work" }).click();
  await page.getByRole("button", { exact: true, name: "Start thread" }).click();

  const threadCard = page.locator(".card").filter({
    has: page.getByText(threadTitle, { exact: true })
  });
  await expect(threadCard.getByText("Work · 0 linked sources", { exact: true })).toBeVisible();
  await threadCard.getByLabel("Exact source ID, note path, or run/checkpoint reference").fill(noteName);
  await threadCard.getByLabel("Source type").selectOption("note");
  await threadCard.getByLabel("How Muse may use it").selectOption("context");
  await threadCard.getByRole("button", { exact: true, name: "Link source" }).click();
  await expect(threadCard.getByText("Work · 1 linked sources", { exact: true })).toBeVisible();
  await expect(threadCard.getByRole("button", { exact: true, name: `Remove note:${noteName}` })).toBeVisible();

  const beforeOpen = await readContinuityReview(request);
  expect(beforeOpen.deliveries).toEqual([]);
  expect(beforeOpen.evaluation).toMatchObject({
    measurementStatus: "insufficient",
    outcomes: { adjusted: 0, ignored: 0, rejected: 0, used: 0 },
    totalDeliveries: 0,
    withOutcome: 0
  });
  expect(beforeOpen.reviewQueue.next).toBeUndefined();
  expect(beforeOpen.threads).toEqual([
    expect.objectContaining({
      kind: "work",
      linkCount: 1,
      links: [{
        artifactId: noteName,
        artifactType: "note",
        providerId: "local",
        role: "context"
      }],
      title: threadTitle
    })
  ]);

  const openPackButton = threadCard.getByRole("button", { exact: true, name: "Open pack" });
  await expect(openPackButton).toBeEnabled();
  await openPackButton.click();

  const openedPackCard = page.locator(".card").filter({
    has: page.getByText(`Continuity Pack: ${threadTitle}`, { exact: true })
  });
  await expect(openedPackCard).toBeVisible();
  await expect(openedPackCard.getByText(`${noteName} · note:${noteName}`, { exact: true })).toBeVisible();
  await expect(openedPackCard.getByText(noteContent, { exact: true })).toBeVisible();

  await expect.poll(async () => (await readContinuityReview(request)).deliveries.length).toBe(1);
  const opened = await readContinuityReview(request);
  expect(opened.deliveries).toHaveLength(1);
  const delivery = opened.deliveries[0]!;
  expect(delivery).toMatchObject({
    evidenceRefs: [{
      artifactId: noteName,
      artifactType: "note",
      providerId: "local",
      role: "context"
    }],
    thread: { kind: "work", title: threadTitle }
  });
  expect(delivery.outcome).toBeUndefined();
  expect(opened.evaluation).toMatchObject({
    measurementStatus: "insufficient",
    outcomes: { adjusted: 0, ignored: 0, rejected: 0, used: 0 },
    totalDeliveries: 1,
    withOutcome: 0
  });
  expect(["hold", "manual-only"]).toContain(opened.evaluation.automationGate.status);
  expect(["hold", "manual-only"]).toContain(opened.evaluation.byKind.work.automationGate.status);
  expect(opened.reviewQueue.next).toMatchObject({
    deliveryId: delivery.id,
    evidence: [{
      artifact: expect.objectContaining({
        artifactId: noteName,
        artifactType: "note",
        providerId: "local",
        summary: noteContent,
        title: noteName
      }),
      reference: {
        artifactId: noteName,
        artifactType: "note",
        providerId: "local",
        role: "context"
      },
      status: "available"
    }],
    thread: { kind: "work", title: threadTitle }
  });
  await expect(openedPackCard.getByText(`Work · delivery ${delivery.id}`, { exact: true })).toBeVisible();
  await expect(page.getByText("awaiting feedback", { exact: true })).toBeVisible();

  const usedButton = page.getByRole("button", {
    exact: true,
    name: `Record used for ${delivery.id}`
  });
  await expect(usedButton).toBeEnabled();
  const confirmMessage = await Promise.all([
    page.waitForEvent("dialog").then(async (dialog) => {
      const message = dialog.message();
      expect(dialog.type()).toBe("confirm");
      await dialog.accept();
      return message;
    }),
    usedButton.click()
  ]).then(([message]) => message);
  expect(confirmMessage).toBe(
    "Record 'used' for this delivery? Outcomes are immutable and will update the next pack's display policy."
  );

  await expect.poll(async () => {
    const current = await readContinuityReview(request);
    return current.deliveries[0]?.outcome?.outcome;
  }).toBe("used");

  await page.reload();
  await expect(page.getByText("Connected")).toBeVisible();
  const persisted = await readContinuityReview(request);
  expect(persisted.deliveries).toHaveLength(1);
  expect(persisted.deliveries.filter((entry) => entry.outcome !== undefined)).toHaveLength(1);
  expect(persisted.deliveries[0]).toMatchObject({
    id: delivery.id,
    outcome: { outcome: "used" },
    thread: { kind: "work", title: threadTitle }
  });
  expect(persisted.evaluation).toMatchObject({
    measurementStatus: "insufficient",
    outcomes: { adjusted: 0, ignored: 0, rejected: 0, used: 1 },
    totalDeliveries: 1,
    withOutcome: 1
  });
  expect(["hold", "manual-only"]).toContain(persisted.evaluation.automationGate.status);
  expect(["hold", "manual-only"]).toContain(persisted.evaluation.byKind.work.automationGate.status);
  expect(persisted.evaluation.measurements.some((metric) => metric.claim === "personal-effectiveness")).toBe(false);
  expect(unexpectedEgress).toEqual([]);
});

interface ContinuityReviewSnapshot {
  readonly deliveries: readonly {
    readonly evidenceRefs: readonly {
      readonly artifactId: string;
      readonly artifactType: string;
      readonly providerId: string;
      readonly role: string;
    }[];
    readonly id: string;
    readonly outcome?: { readonly outcome: string };
    readonly thread: { readonly kind: string; readonly title: string };
  }[];
  readonly evaluation: {
    readonly automationGate: { readonly status: "hold" | "manual-only" };
    readonly byKind: {
      readonly work: { readonly automationGate: { readonly status: "hold" | "manual-only" } };
    };
    readonly measurements: readonly { readonly claim: string }[];
    readonly measurementStatus: "available" | "insufficient";
    readonly outcomes: Readonly<Record<"adjusted" | "ignored" | "rejected" | "used", number>>;
    readonly totalDeliveries: number;
    readonly withOutcome: number;
  };
  readonly reviewQueue: {
    readonly next?: {
      readonly deliveryId: string;
      readonly evidence: readonly {
        readonly artifact?: {
          readonly artifactId: string;
          readonly artifactType: string;
          readonly providerId: string;
          readonly summary?: string;
          readonly title: string;
        };
        readonly reference: {
          readonly artifactId: string;
          readonly artifactType: string;
          readonly providerId: string;
          readonly role: string;
        };
        readonly status: string;
      }[];
      readonly thread: { readonly kind: string; readonly title: string };
    };
  };
  readonly threads: readonly {
    readonly kind: string;
    readonly linkCount: number;
    readonly links: readonly {
      readonly artifactId: string;
      readonly artifactType: string;
      readonly providerId: string;
      readonly role: string;
    }[];
    readonly title: string;
  }[];
}

async function readContinuityReview(request: APIRequestContext): Promise<ContinuityReviewSnapshot> {
  const response = await request.get(`${apiUrl}/api/attunement/review`);
  expect(response.status()).toBe(200);
  return await response.json() as ContinuityReviewSnapshot;
}

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
