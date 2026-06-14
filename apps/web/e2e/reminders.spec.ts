import { expect, test } from "@playwright/test";

const ok = (json: unknown) => ({ contentType: "application/json", json });

test("reminders form is label-associated and adds a reminder", async ({ page }) => {
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

  let posted: { text?: string } | null = null;
  await page.route("**/api/reminders**", async (route) => {
    if (route.request().method() === "POST") {
      posted = route.request().postDataJSON();
      await route.fulfill({ ...ok({ id: "r1", text: "Call dentist", dueAt: "2026-07-01T09:00:00Z", status: "pending" }), status: 201 });
    } else {
      await route.fulfill(ok({ reminders: [], total: 0 }));
    }
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Reminders" }).click();

  // The form's labels must be tied to their inputs (WCAG 1.3.1) — drive via label.
  await page.getByLabel("What").fill("Call dentist");
  await page.getByLabel("When").fill("2026-07-01T09:00");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect.poll(() => posted).toMatchObject({ text: "Call dentist" });
});
