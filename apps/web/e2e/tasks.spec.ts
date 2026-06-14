import { expect, test } from "@playwright/test";

const ok = (json: unknown) => ({ contentType: "application/json", json });

test("tasks view filters the loaded list by the search box", async ({ page }) => {
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
  await page.route("**/api/proactive/history**", (route) => route.fulfill(ok({ entries: [] })));
  await page.route("**/api/tasks**", (route) =>
    route.fulfill(
      ok({
        status: "open",
        total: 2,
        tasks: [
          { id: "t1", title: "Pay the dentist bill", status: "open", createdAt: new Date().toISOString() },
          { id: "t2", title: "Buy milk", status: "open", createdAt: new Date().toISOString() }
        ]
      })
    )
  );

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();
  await expect(page.getByText("Pay the dentist bill")).toBeVisible();
  await expect(page.getByText("Buy milk")).toBeVisible();

  // Typing in the search box filters the rendered list client-side.
  await page.getByRole("searchbox", { name: "Filter tasks…" }).fill("dentist");
  await expect(page.getByText("Pay the dentist bill")).toBeVisible();
  await expect(page.getByText("Buy milk")).toHaveCount(0);
});
