import { expect, test } from "@playwright/test";

const ok = (json: unknown) => ({ contentType: "application/json", json });

test("console renders Today, navigates to Chat, and round-trips a message", async ({ page }) => {
  await page.route("**/api/health", (route) => route.fulfill(ok({ service: "muse-api", status: "ok" })));
  await page.route("**/api/today", (route) =>
    route.fulfill(
      ok({
        events: [{ id: "e1", startsAtIso: new Date(Date.now() + 3_600_000).toISOString(), title: "Standup" }],
        generatedAt: new Date().toISOString(),
        lookaheadHours: 24,
        reminders: [],
        tasks: [{ id: "t1", title: "Ship the rebuild" }]
      })
    )
  );
  await page.route("**/api/tasks**", (route) =>
    route.fulfill(
      ok({
        status: "open",
        tasks: [{ createdAt: new Date().toISOString(), id: "t1", status: "open", title: "Ship the rebuild" }],
        total: 1
      })
    )
  );
  await page.route("**/api/proactive/history**", (route) => route.fulfill(ok({ entries: [] })));
  await page.route("**/api/chat", async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toMatchObject({ message: "what is due today" });
    await route.fulfill(ok({ content: "You have 1 task due: Ship the rebuild.", runId: "run-1" }));
  });

  await page.goto("/");

  await expect(page.getByText("AI Conductor")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: /Stark/ })).toBeVisible();
  await expect(page.getByText("Ship the rebuild").first()).toBeVisible();

  await page.getByRole("button", { name: "Chat" }).click();
  await page.getByPlaceholder(/Message Muse/).fill("what is due today");
  await page.getByTitle("Send").click();

  await expect(page.getByText("You have 1 task due: Ship the rebuild.")).toBeVisible();
});
