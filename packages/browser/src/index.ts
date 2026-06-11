/**
 * `@muse/browser` — Muse's NATIVE browser-control tools (Hermes-style
 * `browser_*`) over the user's Chrome via puppeteer-core / CDP. NOT
 * MCP-protocol tools; depends only on `@muse/tools` + `@muse/shared` +
 * puppeteer-core (Apache-2.0). The approval gate + browser controller
 * are injected, so the outbound-safety wiring lives at the CLI boundary.
 */

export * from "./controller.js";
export * from "./browser-tools.js";
export { PuppeteerBrowserController, type PuppeteerBrowserControllerOptions } from "./puppeteer-controller.js";
