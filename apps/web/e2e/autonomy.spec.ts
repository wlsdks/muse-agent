import { expect, test } from "@playwright/test";

const ok = (json: unknown) => ({ contentType: "application/json", json });

test("autonomy view shows actions/objectives/vetoes and adds a contact", async ({ page }) => {
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

  await page.route("**/api/actions**", (route) =>
    route.fulfill(ok({ actions: [{ id: "a1", result: "performed", what: "Emailed the standup notes", when: new Date().toISOString(), why: "objective: daily recap" }], total: 1 }))
  );
  await page.route("**/api/objectives**", (route) =>
    route.fulfill(ok({ objectives: [{ createdAt: new Date().toISOString(), id: "o1", kind: "watch", spec: "Watch the build until green", status: "active" }], total: 1 }))
  );
  await page.route("**/api/vetoes**", (route) =>
    route.fulfill(ok({ total: 1, vetoes: [{ id: "v1", objectiveId: "o1", reason: "too noisy", scope: "email:boss", vetoedAt: new Date().toISOString() }] }))
  );

  let postedContact: unknown = null;
  await page.route("**/api/contacts", async (route) => {
    if (route.request().method() === "POST") {
      postedContact = route.request().postDataJSON();
      await route.fulfill(ok({ id: "c1", name: "Dr. Kim" }));
    } else {
      await route.fulfill(ok({ contacts: [], total: 0 }));
    }
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Autonomy" }).click();

  // Action log is the default tab.
  await expect(page.getByText("Emailed the standup notes")).toBeVisible();

  await page.getByRole("button", { name: "Objectives" }).click();
  await expect(page.getByText("Watch the build until green")).toBeVisible();

  await page.getByRole("button", { name: "Avoidances" }).click();
  await expect(page.getByText("email:boss")).toBeVisible();

  await page.getByRole("button", { name: "Contacts" }).click();
  // The contact form's labels must be tied to their inputs (WCAG 1.3.1) so a
  // screen reader names each field — drive the form via the label, not placeholder.
  await page.getByLabel("Name").fill("Dr. Kim");
  await page.getByLabel("Phone").fill("+1 415 555 0101");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect.poll(() => postedContact).toMatchObject({ name: "Dr. Kim", phone: "+1 415 555 0101" });
});
