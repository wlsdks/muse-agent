import { expect, test } from "@playwright/test";

const ok = (json: unknown) => ({ contentType: "application/json", json });

test("messaging send is draft-first: nothing leaves until explicit confirm", async ({ page }) => {
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
  await page.route("**/api/messaging/providers", (route) => route.fulfill(ok({ providers: [{ displayName: "Local log", id: "log", local: true }] })));
  await page.route("**/api/messaging/inbox**", (route) => route.fulfill(ok({ inbound: [], providerId: "log", total: 0 })));

  let sendCount = 0;
  let sentBody: unknown = null;
  await page.route("**/api/messaging/send", async (route) => {
    sendCount += 1;
    sentBody = route.request().postDataJSON();
    await route.fulfill(ok({ messageId: "m1" }));
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Messaging" }).click();

  // The compose form's labels must be tied to their inputs (WCAG 1.3.1) — drive
  // the form via the label so a screen reader names the recipient + message.
  await page.getByLabel("To").fill("#general");
  await page.getByLabel("Message").fill("Deploying v2 now.");

  // Review shows the confirm panel but MUST NOT send.
  await page.getByRole("button", { name: "Review" }).click();
  await expect(page.getByText("Confirm send")).toBeVisible();
  await expect(page.getByText("Deploying v2 now.")).toBeVisible();
  expect(sendCount).toBe(0);

  // Cancel sends nothing.
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("button", { name: "Review" })).toBeVisible();
  expect(sendCount).toBe(0);

  // Only explicit confirm sends — with the exact authored content.
  await page.getByRole("button", { name: "Review" }).click();
  await page.getByRole("button", { name: "Confirm & send" }).click();
  await expect.poll(() => sentBody).toMatchObject({ destination: "#general", providerId: "log", text: "Deploying v2 now." });
  expect(sendCount).toBe(1);
});
