import { expect, test } from "@playwright/test";

const ok = (json: unknown) => ({ contentType: "application/json", json });

test("command palette opens with the keyboard and navigates", async ({ page }) => {
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
  await page.route("**/api/calendar/events", (route) => route.fulfill(ok({ events: [], total: 0 })));

  await page.goto("/");
  await expect(page.getByRole("heading", { level: 2, name: "Today" })).toBeVisible();

  // ⌘K opens the palette; typing filters; Enter navigates.
  await page.keyboard.press("Meta+k");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
  await page.getByPlaceholder(/Jump to a view/).fill("calendar");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 2, name: "Calendar" })).toBeVisible();

  // The `g` leader jumps directly (g then t -> Today).
  await page.keyboard.press("g");
  await page.keyboard.press("t");
  await expect(page.getByRole("heading", { level: 2, name: "Today" })).toBeVisible();
});

test("command palette dialog is localized — Korean users get a Korean accessible name", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("muse.lang", "ko");
    window.localStorage.setItem("muse.apiUrl", "http://127.0.0.1:3030");
  });
  await page.route("**/api/health", (route) => route.fulfill(ok({ status: "ok" })));
  await page.route("**/api/today", (route) =>
    route.fulfill(ok({ events: [], generatedAt: new Date().toISOString(), lookaheadHours: 24, reminders: [], tasks: [] }))
  );
  await page.route("**/api/tasks**", (route) => route.fulfill(ok({ status: "open", tasks: [], total: 0 })));
  await page.route("**/api/proactive/history**", (route) => route.fulfill(ok({ entries: [] })));
  await page.route("**/api/calendar/events", (route) => route.fulfill(ok({ events: [], total: 0 })));

  await page.goto("/");
  await page.keyboard.press("Meta+k");
  // The dialog's accessible name must come from the dictionary, not a hardcoded
  // English literal — so a Korean screen-reader user hears a Korean name.
  await expect(page.getByRole("dialog", { name: "명령 팔레트" })).toBeVisible();
});

test("command palette exposes the combobox a11y pattern and ArrowDown moves the active descendant", async ({ page }) => {
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
  await page.route("**/api/calendar/events", (route) => route.fulfill(ok({ events: [], total: 0 })));

  await page.goto("/");
  await expect(page.getByRole("heading", { level: 2, name: "Today" })).toBeVisible();

  await page.keyboard.press("Meta+k");
  const combobox = page.getByRole("combobox");
  await expect(combobox).toBeVisible();
  await expect(page.getByRole("listbox")).toBeVisible();
  await expect(combobox).toHaveAttribute("aria-controls", "command-palette-listbox");

  // The combobox points at a selected option, and ArrowDown advances it.
  const first = await combobox.getAttribute("aria-activedescendant");
  expect(first).toBeTruthy();
  await expect(page.locator(`#${first}`)).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("ArrowDown");
  const second = await combobox.getAttribute("aria-activedescendant");
  expect(second).toBeTruthy();
  expect(second).not.toBe(first);
  await expect(page.locator(`#${second}`)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(`#${first}`)).toHaveAttribute("aria-selected", "false");
});
