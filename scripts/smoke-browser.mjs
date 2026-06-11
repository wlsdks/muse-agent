/**
 * smoke:browser — REAL headless-Chrome round-trip for @muse/browser, on
 * local file:// fixtures only (no network, no LLM). Proves the deterministic
 * observation/grounding layer against a live Chrome:
 *
 *   1. SPA settle      — content rendered after domcontentloaded is still seen
 *   2. shadow DOM      — elements inside open shadow roots are listed AND clickable
 *   3. <select> ground — type() picks the matching option; an unmatchable
 *                        option throws and changes NOTHING (fail-close)
 *   4. dedup           — repeated nav links collapse to one entry
 *   5. fixed-position  — position:fixed controls (cookie banners) are visible
 *
 * Skips (exit 0) when Chrome is not installed — a skip is not a pass.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { PuppeteerBrowserController } from "../packages/browser/dist/index.js";

const SPA_HTML = `<!doctype html><html><head><title>SPA</title></head><body><div id="root"></div>
<script>setTimeout(() => {
  document.getElementById("root").innerHTML =
    '<p>Rendered application content arrives late, after domcontentloaded fired.</p>' +
    '<button onclick="this.textContent=\\'Started!\\'">Start here</button>';
}, 900);</script></body></html>`;

const SHADOW_HTML = `<!doctype html><html><head><title>Shadow</title></head><body>
<p>Host page text around the component.</p>
<my-widget></my-widget>
<div id="log"></div>
<script>
class MyWidget extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = '<button id="b">Shadow action</button>';
    root.getElementById("b").addEventListener("click", () => {
      document.getElementById("log").textContent = "shadow-clicked";
    });
  }
}
customElements.define("my-widget", MyWidget);
</script></body></html>`;

const SELECT_HTML = `<!doctype html><html><head><title>Select</title></head><body>
<label for="country">Country</label>
<select id="country" aria-label="Country" onchange="document.getElementById('chosen').textContent='chose:'+this.value">
  <option value="">Select a country</option>
  <option value="CA">Canada</option>
  <option value="KR">South Korea</option>
</select>
<div id="chosen">chose:none</div>
<input aria-label="Search" placeholder="Search"
  oninput="document.getElementById('typed').textContent='typed:'+this.value">
<div id="typed">typed:none</div>
<a href="#a">Pricing</a><a href="#b">Pricing</a><a href="#c">Pricing</a>
<button style="position:fixed;bottom:0;left:0">Accept cookies</button>
</body></html>`;

function assert(condition, label) {
  if (!condition) throw new Error(`ASSERT FAILED: ${label}`);
  console.log(`  ✓ ${label}`);
}

const dir = await mkdtemp(join(tmpdir(), "muse-browser-smoke-"));
const controller = new PuppeteerBrowserController({
  headless: true,
  userDataDir: join(dir, "profile")
});

let launched = false;
try {
  await writeFile(join(dir, "spa.html"), SPA_HTML);
  await writeFile(join(dir, "shadow.html"), SHADOW_HTML);
  await writeFile(join(dir, "select.html"), SELECT_HTML);

  console.log("1) SPA settle — late-rendered content is observed");
  let snap;
  try {
    snap = await controller.open(pathToFileURL(join(dir, "spa.html")).href);
    launched = true;
  } catch (cause) {
    console.log(`SKIP: Chrome unavailable (${cause instanceof Error ? cause.message.split("\n")[0] : cause})`);
    process.exit(0);
  }
  assert(snap.text.includes("Rendered application content"), "settled snapshot carries the late text");
  assert(snap.elements.some((el) => el.name === "Start here"), "late-rendered button is listed");

  console.log("2) shadow DOM — pierced for observation AND action");
  snap = await controller.open(pathToFileURL(join(dir, "shadow.html")).href);
  const shadowButton = snap.elements.find((el) => el.name === "Shadow action");
  assert(shadowButton !== undefined, "button inside an open shadow root is listed");
  snap = await controller.click(shadowButton.ref);
  assert(snap.text.includes("shadow-clicked"), "clicking the shadow-root button works (pierce/)");

  console.log("3) <select> — deterministic option grounding, fail-close on no match");
  snap = await controller.open(pathToFileURL(join(dir, "select.html")).href);
  const select = snap.elements.find((el) => el.role === "combobox");
  assert(select !== undefined, "select is listed with role combobox");
  let failClosed = false;
  try {
    await controller.type(select.ref, "Mars", false);
  } catch {
    failClosed = true;
  }
  assert(failClosed, "unmatchable option throws instead of guessing");
  snap = await controller.snapshot();
  assert(snap.text.includes("chose:none"), "failed select changed NOTHING (no partial side effect)");
  snap = await controller.type(select.ref, "korea", false);
  assert(snap.text.includes("chose:KR"), "free-text 'korea' grounded to the South Korea option");

  console.log("3b) text input — locator fill emits real input events");
  const searchBox = snap.elements.find((el) => el.role === "textbox" && el.name === "Search");
  assert(searchBox !== undefined, "search input is listed");
  snap = await controller.type(searchBox.ref, "wireless mouse", false);
  assert(snap.text.includes("typed:wireless mouse"), "fill typed the text and fired input events");

  console.log("4) dedup + 5) fixed-position visibility");
  const pricing = snap.elements.filter((el) => el.name === "Pricing");
  assert(pricing.length === 1, "3 identical nav links collapse to 1");
  assert(snap.elements.some((el) => el.name === "Accept cookies"), "position:fixed button is visible");

  console.log("6) cross-invocation reconnect — a second controller drives the SAME Chrome");
  const second = new PuppeteerBrowserController({ headless: true, userDataDir: join(dir, "profile") });
  const reSnap = await second.snapshot();
  assert(reSnap.url === snap.url, "new controller reconnected to the running browser (no profile-lock crash)");

  console.log("\nsmoke:browser PASS");
} finally {
  if (launched) await controller.close();
  await rm(dir, { force: true, recursive: true });
}
