import { expect, test } from "@playwright/test";

const ok = (json: unknown) => ({ contentType: "application/json", json });

test("toggles between English and Korean across the UI", async ({ page }) => {
  await page.addInitScript(() => {
    // Seed defaults only when unset so a toggled choice survives reload.
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

  await page.goto("/");

  // English first.
  await expect(page.getByText("AI Conductor")).toBeVisible();
  await expect(page.getByRole("button", { name: "Chat" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: /, Stark/ })).toBeVisible();

  // Switch to Korean via the sidebar toggle.
  await page.getByRole("button", { name: "한", exact: true }).click();

  await expect(page.getByText("AI 지휘자")).toBeVisible();
  await expect(page.getByRole("button", { name: "대화" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: /Stark 님/ })).toBeVisible();

  // Choice persists across reload.
  await page.reload();
  await expect(page.getByText("AI 지휘자")).toBeVisible();
});
