import { expect, test } from "@playwright/test";

const ok = (json: unknown) => ({ contentType: "application/json", json });

test("calendar creates and deletes an event", async ({ page }) => {
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

  let posted: { title?: string } | null = null;
  let deletedUrl = "";
  await page.route("**/api/calendar/events", async (route) => {
    if (route.request().method() === "POST") {
      posted = route.request().postDataJSON();
      await route.fulfill({ ...ok({ id: "e2", providerId: "local", startsAtIso: "2026-06-01T10:00:00Z", endsAtIso: "2026-06-01T11:00:00Z", title: "Review", allDay: false, location: null, notes: null, tags: [], url: null }), status: 201 });
    } else {
      await route.fulfill(
        ok({
          events: [{ allDay: false, endsAtIso: "2026-06-01T11:00:00Z", id: "e1", location: null, notes: null, providerId: "local", startsAtIso: "2026-06-01T10:00:00Z", tags: [], title: "Standup", url: null }],
          total: 1
        })
      );
    }
  });
  await page.route("**/api/calendar/events/**", async (route) => {
    deletedUrl = route.request().url();
    await route.fulfill({ contentType: "application/json", status: 204, body: "" });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Calendar" }).click();
  await expect(page.getByText("Standup")).toBeVisible();

  await page.getByPlaceholder("Standup").fill("Review");
  await page.locator('input[type="datetime-local"]').nth(0).fill("2026-06-01T10:00");
  await page.locator('input[type="datetime-local"]').nth(1).fill("2026-06-01T11:00");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect.poll(() => posted).toMatchObject({ title: "Review" });

  // Icon-only delete buttons must carry an explicit accessible name, not lean
  // on the title tooltip alone (WCAG 4.1.2) — title isn't reliably announced.
  const del = page.getByRole("button", { name: "Delete" }).first();
  await expect(del).toHaveAttribute("aria-label", "Delete");
  await del.click();
  await expect.poll(() => deletedUrl).toContain("providerId=local");
});
