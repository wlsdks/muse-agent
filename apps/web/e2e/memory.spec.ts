import { expect, test } from "@playwright/test";

const ok = (json: unknown) => ({ contentType: "application/json", json });

test("memory view shows learned facts and preferences", async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.localStorage.getItem("muse.lang")) {
      window.localStorage.setItem("muse.lang", "en");
    }
    window.localStorage.setItem("muse.apiUrl", "http://127.0.0.1:3030");
  });
  await page.route("**/api/health", (route) => route.fulfill(ok({ status: "ok" })));
  await page.route("**/api/today", (route) =>
    route.fulfill(ok({ events: [], generatedAt: new Date().toISOString(), lookaheadHours: 24, reminders: [], tasks: [] }))
  );
  await page.route("**/api/tasks**", (route) => route.fulfill(ok({ status: "open", tasks: [], total: 0 })));
  await page.route("**/api/proactive/history**", (route) => route.fulfill(ok({ entries: [] })));
  await page.route("**/api/agent-notices/stream**", (route) => route.fulfill({ body: "event: open\ndata: {}\n\n", contentType: "text/event-stream" }));
  await page.route("**/api/user-memory/**", (route) =>
    route.fulfill(ok({ facts: { dentist: "Dr. Kim" }, preferences: { tone: "concise" }, recentTopics: ["muse"], updatedAt: new Date().toISOString() }))
  );

  await page.goto("/");
  await page.getByRole("button", { name: "Memory" }).click();

  await expect(page.getByRole("heading", { level: 2, name: "Memory" })).toBeVisible();
  await expect(page.getByText("Dr. Kim")).toBeVisible();
  await expect(page.getByText("dentist")).toBeVisible();
  await expect(page.getByText("concise")).toBeVisible();
  await expect(page.locator(".badge", { hasText: "muse" })).toBeVisible();
});
