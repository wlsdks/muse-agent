import { expect, test } from "@playwright/test";

const liveApiUrl = "http://127.0.0.1:3001";

test("console talks to a live diagnostic API", async ({ page }) => {
  await page.addInitScript((apiUrl) => {
    window.localStorage.setItem("muse.apiUrl", apiUrl);
    window.localStorage.removeItem("muse.token");
  }, liveApiUrl);

  await page.goto("/");

  await expect(page.getByText("AI Conductor")).toBeVisible();
  await expect(page.getByText("Connected")).toBeVisible();

  await page.getByRole("button", { name: "Chat" }).click();
  await page.getByPlaceholder(/Message Muse/).fill("diagnostic web smoke");
  await page.getByTitle("Send").click();

  await expect(page.locator(".msg.assistant .bubble").last()).toContainText(/Diagnostic/i);
});
