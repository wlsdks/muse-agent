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
 *   6. reconnect       — a second controller drives the SAME running Chrome
 *   7. same-origin iframe — embedded controls are observed AND clickable cross-frame
 *   8. element paging  — the controller collects past the 50-element display cap
 *   9. scroll          — scrolling reveals lazily-loaded content
 *  10. JS dialog       — confirm/alert is auto-handled (no hang) and reported
 *  11. async-after-act — DOM-stable settle catches content inserted post-click
 *  12. disabled        — disabled controls are omitted (no wasted clicks)
 *  13. new tab         — a target=_blank click is FOLLOWED (new page observed)
 *  14. autocomplete    — typing reveals suggestions (settle catches them)
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

// srcdoc inherits the parent's origin → same-origin (NOT a cross-origin frame).
// The onclick uses String.fromCharCode (no nested quotes) so the srcdoc value
// survives HTML-attribute parsing intact; clicking sets the text to "OK".
const IFRAME_HTML = `<!doctype html><html><head><title>Iframe</title></head><body>
<p>Parent page around the embed.</p>
<iframe srcdoc='<button id="b" onclick="this.textContent=String.fromCharCode(79,75)">Embedded action</button>'></iframe>
</body></html>`;

const PAGING_HTML = `<!doctype html><html><head><title>Paging</title></head><body>
${Array.from({ length: 60 }, (_v, i) => `<a href="#l${String(i)}">link ${String(i)}</a>`).join("")}
</body></html>`;

const SCROLL_HTML = `<!doctype html><html><head><title>Scroll</title></head><body>
<div style="height:3000px">tall spacer</div>
<script>addEventListener("scroll", () => {
  if (window.scrollY > 500 && !document.getElementById("lazy")) {
    const b = document.createElement("button");
    b.id = "lazy"; b.textContent = "Lazy loaded"; document.body.appendChild(b);
  }
});</script>
</body></html>`;

// A confirm() blocks the page until answered — with no handler the next action
// hangs to the timeout. The controller auto-accepts (the act was already
// approved upstream) and reports the dialog.
const DIALOG_HTML = `<!doctype html><html><head><title>Dialog</title></head><body>
<button onclick="if(confirm('Delete this item?'))document.title='CONFIRMED'">Delete</button>
</body></html>`;

// Content inserted 600ms after the click — no network, so networkidle alone
// misses it; the DOM-stable settle must catch it.
const AJAX_HTML = `<!doctype html><html><head><title>Ajax</title></head><body>
<button onclick="setTimeout(() => document.body.insertAdjacentHTML('beforeend','<p>Results loaded</p>'), 600)">Load results</button>
</body></html>`;

const DISABLED_HTML = `<!doctype html><html><head><title>Disabled</title></head><body>
<button disabled>Submit</button><button>Active button</button>
</body></html>`;

const NEWTAB_TARGET_HTML = `<!doctype html><html><head><title>Report</title></head><body><h1>Report detail page</h1></body></html>`;
const NEWTAB_HTML = `<!doctype html><html><head><title>Newtab</title></head><body>
<a href="newtab-target.html" target="_blank">Open report</a>
</body></html>`;

const AUTOCOMPLETE_HTML = `<!doctype html><html><head><title>Auto</title></head><body>
<input aria-label="Search" oninput="document.getElementById('s').innerHTML=this.value?'<button>Result: '+this.value+'</button>':''">
<div id="s"></div>
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
  await writeFile(join(dir, "iframe.html"), IFRAME_HTML);
  await writeFile(join(dir, "paging.html"), PAGING_HTML);
  await writeFile(join(dir, "scroll.html"), SCROLL_HTML);
  await writeFile(join(dir, "dialog.html"), DIALOG_HTML);
  await writeFile(join(dir, "ajax.html"), AJAX_HTML);
  await writeFile(join(dir, "disabled.html"), DISABLED_HTML);
  await writeFile(join(dir, "newtab.html"), NEWTAB_HTML);
  await writeFile(join(dir, "newtab-target.html"), NEWTAB_TARGET_HTML);
  await writeFile(join(dir, "autocomplete.html"), AUTOCOMPLETE_HTML);

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

  console.log("7) same-origin iframe — embedded control observed AND clickable cross-frame");
  snap = await controller.open(pathToFileURL(join(dir, "iframe.html")).href);
  const embedded = snap.elements.find((el) => el.name === "Embedded action");
  assert(embedded !== undefined, "button inside a same-origin iframe is listed");
  snap = await controller.click(embedded.ref);
  assert(snap.elements.some((el) => el.name === "OK"), "clicking the iframe-embedded button fires its handler (cross-frame)");

  console.log("8) element paging — collects past the 50-element display cap");
  snap = await controller.open(pathToFileURL(join(dir, "paging.html")).href);
  const links = snap.elements.filter((el) => el.role === "link");
  assert(links.length === 60, "all 60 links collected (ceiling > 50, grounding sees the whole set)");

  console.log("9) scroll — reveals lazily-loaded content");
  snap = await controller.open(pathToFileURL(join(dir, "scroll.html")).href);
  assert(!snap.elements.some((el) => el.name === "Lazy loaded"), "lazy content absent before scroll");
  snap = await controller.scroll("bottom");
  assert(snap.elements.some((el) => el.name === "Lazy loaded"), "lazy content revealed after scroll");

  console.log("10) JS dialog — confirm() auto-handled (no hang) and reported");
  snap = await controller.open(pathToFileURL(join(dir, "dialog.html")).href);
  snap = await controller.click(snap.elements.find((el) => el.name === "Delete").ref);
  assert(snap.title === "CONFIRMED", "confirm() accepted so the approved action completed (no timeout hang)");
  assert(snap.dialog?.type === "confirm", "the dialog is reported transparently in the snapshot");

  console.log("11) async-after-action — DOM-stable settle catches post-click content");
  snap = await controller.open(pathToFileURL(join(dir, "ajax.html")).href);
  snap = await controller.click(snap.elements.find((el) => el.name === "Load results").ref);
  assert(snap.text.includes("Results loaded"), "content inserted 600ms after the click is observed");

  console.log("12) disabled controls — omitted so the model never wastes a turn on them");
  snap = await controller.open(pathToFileURL(join(dir, "disabled.html")).href);
  assert(!snap.elements.some((el) => el.name === "Submit"), "disabled button is omitted from the element list");
  assert(snap.elements.some((el) => el.name === "Active button"), "enabled button is still listed");

  console.log("13) new tab — a target=_blank click is followed (new page observed)");
  snap = await controller.open(pathToFileURL(join(dir, "newtab.html")).href);
  snap = await controller.click(snap.elements.find((el) => el.name === "Open report").ref);
  assert(snap.text.includes("Report detail page"), "the controller follows the new tab, not the stale opener");

  console.log("14) autocomplete — typing reveals suggestions");
  snap = await controller.open(pathToFileURL(join(dir, "autocomplete.html")).href);
  snap = await controller.type(snap.elements.find((el) => el.role === "textbox").ref, "laptop", false);
  assert(snap.elements.some((el) => el.name.includes("Result: laptop")), "the suggestion rendered on input is observed");

  console.log("\nsmoke:browser PASS");
} finally {
  if (launched) await controller.close();
  // close() terminates the detached Chrome over CDP, but the OS process releases
  // its profile file handles a beat later — retry the temp cleanup so the race
  // never turns a green smoke into a non-zero exit (and never fail on cleanup).
  await rm(dir, { force: true, maxRetries: 10, recursive: true, retryDelay: 200 }).catch(() => { /* temp dir; OS reaps it */ });
}
