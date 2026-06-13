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
 *  15. repeated actions — per-row buttons stay distinct + ordinal targets the right one
 *  16. hover menu      — hovering reveals a submenu, then its item is clickable
 *  17. form labels     — radio/checkbox/input named by VISIBLE label, not value
 *  18. keyboard        — Escape closes a modal (browser_key)
 *  20. nav status      — a real localhost 404/500 (goto resolves on it) surfaces
 *                        httpStatus so an error page can't pass for content; a
 *                        200 carries NO status (silent success)
 *  21. protocol timeout — a CDP roundtrip that never returns (a page with a
 *                        forever-blocking innerText getter, read by the snapshot
 *                        evaluate which has no higher-level timeout) fails fast
 *                        within the bound, not after puppeteer's silent 180s
 *                        default — a stuck page can't wedge the agent
 *  22. browser_wait     — content inserted AFTER open()'s settle (a quiet page,
 *                        then a delayed timer) is missed by a bare read but
 *                        waited-for by waitFor(text|selector); an unmet
 *                        condition reports matched=false (no fabricated success)
 *  23. act-nav status   — a CLICK that NAVIGATES to a real localhost 404 (the
 *                        act path never went through goto, so it had no status)
 *                        now captures httpStatus on the click snapshot, while a
 *                        click landing on a 200 carries none — so an error page
 *                        reached by acting can't pass for the requested content
 *
 * Skips (exit 0) when Chrome is not installed — a skip is not a pass.
 */
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { PuppeteerBrowserController, matchElement, statusFields } from "../packages/browser/dist/index.js";

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
<a href="#pricing">Pricing</a><a href="#pricing">Pricing</a><a href="#pricing">Pricing</a>
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

// A prompt() with a default value — a bare dialog.accept() submits "" and the
// page proceeds with blank input (silent garbage). The handler must accept the
// dialog's OWN defaultValue ("SAVE10"), so the page receives the intended text
// and the snapshot records what was sent.
const PROMPT_HTML = `<!doctype html><html><head><title>Prompt</title></head><body>
<button onclick="document.title='code:'+prompt('Enter coupon code','SAVE10')">Apply coupon</button>
</body></html>`;

// Content inserted 600ms after the click — no network, so networkidle alone
// misses it; the DOM-stable settle must catch it.
const AJAX_HTML = `<!doctype html><html><head><title>Ajax</title></head><body>
<button onclick="setTimeout(() => document.body.insertAdjacentHTML('beforeend','<p>Results loaded</p>'), 600)">Load results</button>
</body></html>`;

// The page is QUIET at load (real text + a control already present, so it is
// NOT looksUnsettled and the settle/retry path can't help), then a delayed
// timer inserts the awaited content LATER — well after open()'s 400ms-quiet
// settle has already returned. A bare read right after open misses it; only
// browser_wait, which polls until the text/selector appears, catches it.
const WAIT_HTML = `<!doctype html><html><head><title>Order</title></head><body>
<h1>Checkout</h1><p>Processing your order, please wait. This page has plenty of static text already on it.</p>
<button>Cancel</button>
<div id="status"></div>
<script>setTimeout(() => {
  document.getElementById("status").innerHTML = '<p class="result">Order confirmed #A12</p>';
}, 2500);</script></body></html>`;

const DISABLED_HTML = `<!doctype html><html><head><title>Disabled</title></head><body>
<button disabled>Submit</button><button>Active button</button>
</body></html>`;

// A real file-upload form: a labelled <input type=file> plus an unrelated text
// button. uploadFile must call setInputFiles on the file input (files.length → 1)
// and a NON-file element must be REFUSED (the controller throws, nothing attached).
const UPLOAD_HTML = `<!doctype html><html><head><title>Apply</title></head><body>
<h1>Job application</h1>
<label for="cv">Attach resume</label>
<input id="cv" type="file" aria-label="Attach resume"
  onchange="document.getElementById('att').textContent='attached:'+this.files.length+':'+(this.files[0]?this.files[0].name:'')">
<button type="button">Submit application</button>
<div id="att">attached:0:</div>
</body></html>`;

const NEWTAB_TARGET_HTML = `<!doctype html><html><head><title>Report</title></head><body><h1>Report detail page</h1></body></html>`;
const NEWTAB_HTML = `<!doctype html><html><head><title>Newtab</title></head><body>
<a href="newtab-target.html" target="_blank">Open report</a>
</body></html>`;

const AUTOCOMPLETE_HTML = `<!doctype html><html><head><title>Auto</title></head><body>
<input aria-label="Search" oninput="document.getElementById('s').innerHTML=this.value?'<button>Result: '+this.value+'</button>':''">
<div id="s"></div>
</body></html>`;

// Two products, each with an identically-labelled "Add to cart" — they must stay
// distinct (NOT collapsed) so ordinal grounding can target the right one.
const REPEAT_HTML = `<!doctype html><html><head><title>Shop</title></head><body>
<div>Apple <button onclick="document.title='apple'">Add to cart</button></div>
<div>Banana <button onclick="document.title='banana'">Add to cart</button></div>
</body></html>`;

// A submenu hidden until the (link) nav item is hovered — the realistic dropdown
// nav. Hovering "Account" must reveal "Billing", then clicking it must work (the
// nested item keeps :hover active).
const HOVER_HTML = `<!doctype html><html><head><title>Nav</title><style>#m{display:none} li:hover #m{display:block}</style></head><body>
<ul><li style="list-style:none;display:inline-block;padding:20px">
<a href="#account">Account</a>
<div id="m"><button onclick="document.title='BILLING'">Billing</button></div>
</li></ul></body></html>`;

// Form controls named by their VISIBLE label (wrapping <label>, <label for>), not
// the value/name attribute — the model targets "Pro plan" / "Email address".
const FORM_HTML = `<!doctype html><html><head><title>Form</title></head><body>
<label><input type="radio" name="plan" value="pro" onclick="document.title='chose:pro'"> Pro plan</label>
<label><input type="radio" name="plan" value="free"> Free</label>
<label for="em">Email address</label><input id="em" type="email">
</body></html>`;

// A modal opened by a button and dismissed by Escape — only a keyboard action can
// close it (no visible close button).
const MODAL_HTML = `<!doctype html><html><head><title>Modal</title></head><body>
<button onclick="document.getElementById('m').style.display='block'">Open dialog</button>
<div id="m" style="display:none"><p>MODAL OPEN</p></div>
<script>addEventListener("keydown", (e) => { if (e.key === "Escape") document.getElementById("m").style.display = "none"; });</script>
</body></html>`;

// Links carry their resolved absolute destination in the snapshot so the model
// can report WHERE a link goes (or hand the user a shareable URL) without
// navigating. A relative href must resolve to absolute; a button has no url.
const LINKS_HTML = `<!doctype html><html><head><title>Links</title></head><body>
<a href="https://example.com/pricing">See pricing</a>
<a href="docs/start">Docs</a>
<button onclick="void 0">Just a button</button>
</body></html>`;

// A page whose body.innerText getter blocks the JS thread FOREVER. The snapshot
// path reads innerText via page.evaluate — a CDP roundtrip that carries NO
// higher-level timeout — so without a bounded protocolTimeout it hangs for
// puppeteer's silent 180s default (a prod agent that can't be SIGKILLed wedges).
// With the bound, the stuck roundtrip rejects fast and recoverably.
const HANG_HTML = `<!doctype html><html><head><title>Hang</title></head><body><p>placeholder</p>
<script>Object.defineProperty(document.body, "innerText",
  { configurable: true, get() { while (true) {} } });</script>
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

// A real localhost HTTP server so the navigation-status check exercises the
// REAL goto/goBack → HTTPResponse.status() path (file:// has no HTTP status).
// `/ok` → 200, anything else → a 404 error page whose body looks like content.
const statusServer = createServer((req, res) => {
  if (req.url === "/ok") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>OK page</title><h1>The real content</h1>");
    return;
  }
  // A hub page whose links go to a real 404 and a real 200 — clicking them is a
  // genuine main-frame navigation through the ACT path (no goto), so it proves
  // withNavStatus captures the status the click landed on.
  if (req.url === "/hub") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end('<!doctype html><title>Hub</title><h1>Links</h1><a href="/missing">Broken link</a> <a href="/ok">Good link</a>');
    return;
  }
  res.writeHead(404, { "content-type": "text/html" });
  res.end("<!doctype html><title>404 Not Found</title><h1>Not Found</h1><p>No such page.</p>");
});
await new Promise((resolve) => statusServer.listen(0, "127.0.0.1", resolve));
const statusPort = statusServer.address().port;

let launched = false;
try {
  await writeFile(join(dir, "spa.html"), SPA_HTML);
  await writeFile(join(dir, "shadow.html"), SHADOW_HTML);
  await writeFile(join(dir, "select.html"), SELECT_HTML);
  await writeFile(join(dir, "iframe.html"), IFRAME_HTML);
  await writeFile(join(dir, "paging.html"), PAGING_HTML);
  await writeFile(join(dir, "scroll.html"), SCROLL_HTML);
  await writeFile(join(dir, "dialog.html"), DIALOG_HTML);
  await writeFile(join(dir, "prompt.html"), PROMPT_HTML);
  await writeFile(join(dir, "ajax.html"), AJAX_HTML);
  await writeFile(join(dir, "wait.html"), WAIT_HTML);
  await writeFile(join(dir, "disabled.html"), DISABLED_HTML);
  await writeFile(join(dir, "upload.html"), UPLOAD_HTML);
  await writeFile(join(dir, "resume.txt"), "This is the resume content being attached.");
  await writeFile(join(dir, "newtab.html"), NEWTAB_HTML);
  await writeFile(join(dir, "newtab-target.html"), NEWTAB_TARGET_HTML);
  await writeFile(join(dir, "autocomplete.html"), AUTOCOMPLETE_HTML);
  await writeFile(join(dir, "repeat.html"), REPEAT_HTML);
  await writeFile(join(dir, "hover.html"), HOVER_HTML);
  await writeFile(join(dir, "form.html"), FORM_HTML);
  await writeFile(join(dir, "modal.html"), MODAL_HTML);
  await writeFile(join(dir, "links.html"), LINKS_HTML);

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
  assert(pricing.length === 1, "3 same-href nav links collapse to 1 (distinct hrefs would stay)");
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

  console.log("10b) prompt() dialog — accepted with the page's defaultValue (not blank) and recorded");
  snap = await controller.open(pathToFileURL(join(dir, "prompt.html")).href);
  snap = await controller.click(snap.elements.find((el) => el.name === "Apply coupon").ref);
  assert(snap.title === "code:SAVE10", "prompt received the page's defaultValue, not an empty string");
  assert(snap.dialog?.type === "prompt", "the prompt dialog is reported transparently");
  assert(snap.dialog?.response === "SAVE10", "the submitted prompt text is surfaced so the model knows what was sent");

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

  console.log("15) repeated actions — per-row buttons stay distinct + ordinal targets the right one");
  snap = await controller.open(pathToFileURL(join(dir, "repeat.html")).href);
  assert(snap.elements.filter((el) => el.name === "Add to cart").length === 2, "both per-row 'Add to cart' buttons are listed (not deduped)");
  const secondAdd = matchElement(snap.elements, "the second Add to cart", "click");
  snap = await controller.click(secondAdd.ref);
  assert(snap.title === "banana", "'the second Add to cart' grounds to Banana's button, not Apple's");

  console.log("16) hover menu — hovering reveals a submenu, then its item is clickable");
  snap = await controller.open(pathToFileURL(join(dir, "hover.html")).href);
  assert(!snap.elements.some((el) => el.name === "Billing"), "submenu item is hidden before hover");
  snap = await controller.hover(matchElement(snap.elements, "Account", "click").ref);
  const billing = matchElement(snap.elements, "Billing", "click");
  assert(billing !== undefined, "hovering the nav item reveals the submenu");
  snap = await controller.click(billing.ref);
  assert(snap.title === "BILLING", "the revealed submenu item is clickable (hover stays active)");

  console.log("17) form labels — controls named by their VISIBLE label, not value/name");
  snap = await controller.open(pathToFileURL(join(dir, "form.html")).href);
  const proRadio = matchElement(snap.elements, "Pro plan", "click");
  assert(proRadio?.name === "Pro plan", "radio is named by its wrapping <label> ('Pro plan'), not value 'pro'");
  assert(matchElement(snap.elements, "Email", "type")?.name === "Email address", "input is named by its <label for>");
  snap = await controller.click(proRadio.ref);
  assert(snap.title === "chose:pro", "the label-grounded radio actually toggles");

  console.log("18) keyboard — Escape closes a modal");
  snap = await controller.open(pathToFileURL(join(dir, "modal.html")).href);
  snap = await controller.click(matchElement(snap.elements, "Open dialog", "click").ref);
  assert(snap.text.includes("MODAL OPEN"), "the modal opens on click");
  snap = await controller.pressKey("Escape");
  assert(!snap.text.includes("MODAL OPEN"), "Escape closes the modal (no visible close button needed)");

  console.log("19) link destinations — a link's resolved url is in the snapshot, a button has none");
  snap = await controller.open(pathToFileURL(join(dir, "links.html")).href);
  const pricingLink = snap.elements.find((element) => element.name === "See pricing");
  assert(pricingLink?.url === "https://example.com/pricing", "absolute link href surfaces as the element url");
  const docsLink = snap.elements.find((element) => element.name === "Docs");
  assert(typeof docsLink?.url === "string" && docsLink.url.endsWith("/docs/start"), "a relative href resolves to an absolute url");
  const justButton = snap.elements.find((element) => element.name === "Just a button");
  assert(justButton !== undefined && justButton.url === undefined, "a non-link control carries no url");

  console.log("20) navigation status — a real 404 (goto resolves on it) is captured; consume-once; statusFields silences a 200");
  snap = await controller.open(`http://127.0.0.1:${String(statusPort)}/missing`);
  assert(snap.httpStatus === 404, "open on a real 404 captures httpStatus from goto's HTTPResponse (proves the real path)");
  assert(snap.text.includes("Not Found"), "the 404 page's body still flows (advisory, not a hard refusal)");
  assert(statusFields(snap).statusError?.includes("404") === true, "statusFields turns the captured 404 into an advisory statusError");
  snap = await controller.snapshot();
  assert(snap.httpStatus === undefined, "consume-once: the status is NOT repeated on a subsequent bare re-read");
  snap = await controller.open(`http://127.0.0.1:${String(statusPort)}/ok`);
  assert(snap.httpStatus === 200, "a 200 IS captured by the controller (real path)");
  assert(Object.keys(statusFields(snap)).length === 0, "but statusFields stays SILENT on a 200 — no false alarm to the model");
  assert(snap.text.includes("The real content"), "the 200 page content flows normally");

  console.log("22) browser_wait — content that appears AFTER the settle is waited-for, then read (honest no-match on a timeout)");
  snap = await controller.open(pathToFileURL(join(dir, "wait.html")).href);
  // open()'s settle returns while the page is quiet, BEFORE the 2.5s insert — so
  // a bare read here genuinely misses the awaited content (proves the gap is real).
  assert(!snap.text.includes("Order confirmed"), "the delayed content is absent right after open (settle/retry can't catch it — real gap)");
  const waitText = await controller.waitFor({ text: "Order confirmed" });
  assert(waitText.matched === true, "waitFor(text) polls until the late content appears (matched=true)");
  assert(waitText.snapshot.text.includes("Order confirmed #A12"), "the awaited text is now in the re-read snapshot");
  // a CSS selector for the same late element resolves too (re-open for a fresh, quiet page)
  snap = await controller.open(pathToFileURL(join(dir, "wait.html")).href);
  const waitSel = await controller.waitFor({ selector: ".result" });
  assert(waitSel.matched === true, "waitFor(selector) resolves once the late element renders");
  // a condition that never holds reports matched=false (no fabricated success), with the live page intact
  snap = await controller.open(pathToFileURL(join(dir, "wait.html")).href);
  const waitMiss = await controller.waitFor({ text: "this string never appears on the page", timeoutMs: 1500 });
  assert(waitMiss.matched === false, "an unmet condition times out to matched=false (honest, not a fabricated success)");
  assert(waitMiss.snapshot.text.includes("Checkout"), "the live page is still returned on a timeout so the model can report what IS there");

  console.log("23) act-nav status — a click that navigates to a real 404 captures httpStatus (act path, no goto); a 200 click carries none");
  snap = await controller.open(`http://127.0.0.1:${String(statusPort)}/hub`);
  assert(snap.httpStatus === 200, "the hub page open captures its real 200 status (baseline)");
  const broken = snap.elements.find((el) => el.name === "Broken link");
  assert(broken !== undefined, "the broken link is listed on the hub");
  snap = await controller.click(broken.ref);
  assert(snap.text.includes("Not Found"), "the click navigated to the 404 page (its body flows, advisory not refusal)");
  assert(snap.httpStatus === 404, "the click that landed on a 404 captures httpStatus via withNavStatus (was undefined before — real gap)");
  assert(statusFields(snap).statusError?.includes("404") === true, "statusFields turns the click-navigation 404 into an advisory statusError");
  snap = await controller.snapshot();
  assert(snap.httpStatus === undefined, "consume-once: a bare re-read after the click carries no stale status");
  snap = await controller.open(`http://127.0.0.1:${String(statusPort)}/hub`);
  snap = await controller.click(snap.elements.find((el) => el.name === "Good link").ref);
  assert(snap.text.includes("The real content"), "the click navigated to the 200 page");
  assert(snap.httpStatus === 200, "a click landing on a 200 captures it (real path), but statusFields silences it — no false alarm");
  assert(Object.keys(statusFields(snap)).length === 0, "statusFields stays SILENT on the 200-click navigation");

  console.log("21) protocol-timeout — a CDP call that never returns fails fast, not after 180s");
  await writeFile(join(dir, "hang.html"), HANG_HTML);
  // A dedicated controller with a SMALL bound so the test is fast: the stuck
  // innerText getter makes the snapshot evaluate hang; without protocolTimeout
  // it would block for puppeteer's 180s default. Reconnects to the same Chrome.
  const boundController = new PuppeteerBrowserController({
    headless: true,
    protocolTimeoutMs: 3_000,
    timeoutMs: 4_000,
    userDataDir: join(dir, "profile")
  });
  const startedAt = Date.now();
  let rejected = false;
  try {
    await boundController.open(pathToFileURL(join(dir, "hang.html")).href);
  } catch {
    rejected = true;
  } finally {
    await boundController.disconnect();
  }
  const elapsedMs = Date.now() - startedAt;
  assert(rejected, "a CDP call that never returns rejects (does not hang the agent forever)");
  assert(elapsedMs < 60_000, `it fails fast within the bound, not puppeteer's 180s default (took ${String(elapsedMs)}ms)`);

  console.log("24) browser_upload — setInputFiles attaches a real file to a real <input type=file>; a non-file element is refused");
  snap = await controller.open(pathToFileURL(join(dir, "upload.html")).href);
  const fileInput = matchElement(snap.elements, "Attach resume", "click");
  assert(fileInput !== undefined, "the labelled file input is listed and grounded by its label");
  assert(snap.text.includes("attached:0:"), "no file attached before the upload (baseline)");
  const resumePath = join(dir, "resume.txt");
  snap = await controller.uploadFile(fileInput.ref, resumePath);
  // The page's onchange records the REAL file count — a fabricated "uploaded"
  // can't pass; setInputFiles must really have populated input.files.
  assert(snap.text.includes("attached:1:resume.txt"), "the file input now holds exactly 1 file named resume.txt (setInputFiles really ran)");
  // A NON-file element (the Submit button) must be refused — fail-close, nothing attached.
  const submitBtn = matchElement(snap.elements, "Submit application", "click");
  let refused = false;
  try {
    await controller.uploadFile(submitBtn.ref, resumePath);
  } catch {
    refused = true;
  }
  assert(refused, "uploadFile on a non-file element THROWS (fail-close — a file is never attached to the wrong control)");

  console.log("\nsmoke:browser PASS");
} finally {
  statusServer.close();
  if (launched) await controller.close();
  // close() terminates the detached Chrome over CDP, but the OS process releases
  // its profile file handles a beat later — retry the temp cleanup so the race
  // never turns a green smoke into a non-zero exit (and never fail on cleanup).
  await rm(dir, { force: true, maxRetries: 10, recursive: true, retryDelay: 200 }).catch(() => { /* temp dir; OS reaps it */ });
}
