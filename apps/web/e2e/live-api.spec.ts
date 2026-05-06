import { expect, test } from "@playwright/test";

const liveApiUrl = "http://127.0.0.1:3001";

test("operator console talks to a live diagnostic API", async ({ page }) => {
  await page.addInitScript((apiUrl) => {
    window.localStorage.setItem("muse.apiUrl", apiUrl);
    window.localStorage.removeItem("muse.token");
  }, liveApiUrl);

  await page.goto("/");

  await expect(page.getByRole("heading", { exact: true, name: "Muse" })).toBeVisible();
  await expect(page.getByLabel("Runtime status")).toContainText("ok");

  await page
    .getByPlaceholder("Compare two product directions, clarify tradeoffs, or choose a next step.")
    .fill("diagnostic web smoke");
  await page.getByRole("button", { name: "Run" }).click();

  await expect(page.locator(".chat-output")).toContainText("Diagnostic response");
});
