import { expect, test } from "@playwright/test";

test("operator console smokes chat and recent runs against API routes", async ({ page }) => {
  await page.route("http://127.0.0.1:3000/health", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: { service: "muse-api", status: "ok" }
    });
  });
  await page.route("http://127.0.0.1:3000/admin/summary", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        recentRuns: [
          {
            id: "run-1",
            inputPreview: "Choose release path",
            model: "test-model",
            provider: "test",
            status: "completed"
          }
        ]
      }
    });
  });
  await page.route("http://127.0.0.1:3000/api/chat", async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({ message: "Compare launch options" });
    await route.fulfill({
      contentType: "application/json",
      json: { response: "Use the lower-risk release path.", runId: "run-chat" }
    });
  });

  await page.goto("/");

  await expect(page.getByRole("heading", { exact: true, name: "Muse" })).toBeVisible();
  await expect(page.getByLabel("Runtime status")).toContainText("ok");
  await expect(page.getByLabel("Recent runs")).toContainText("completed");

  await page.getByPlaceholder("Compare two product directions, clarify tradeoffs, or choose a next step.").fill("Compare launch options");
  await page.getByRole("button", { name: "Run" }).click();

  await expect(page.locator(".chat-output")).toContainText("Use the lower-risk release path.");
});
