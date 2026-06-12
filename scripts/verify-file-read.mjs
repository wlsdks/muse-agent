/**
 * eval:file-read — REAL-PDF round-trip for the file_read tool, no LLM.
 *
 * Generates a genuine PDF with headless Chrome (page.pdf — same detached
 * spawn+connect path the browser controller uses would be overkill here, a
 * plain puppeteer launch is fine for a build-and-discard fixture), then:
 *   1. extractPdfTextWithPdfjs pulls the text back out of the real PDF
 *   2. the file_read TOOL resolves a name fragment in a temp root and reads it
 *   3. outside-root + unmatched-name stay fail-closed
 *
 * Skips (exit 0) when Chrome is not installed.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import puppeteer from "../packages/browser/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js";

import { createFileReadTool, extractPdfTextWithPdfjs } from "../packages/mcp/dist/index.js";

function assert(condition, label) {
  if (!condition) throw new Error(`ASSERT FAILED: ${label}`);
  console.log(`  ✓ ${label}`);
}

const dir = await mkdtemp(join(tmpdir(), "muse-file-read-"));
const downloads = join(dir, "Downloads");
await writeFile(join(dir, "outside-secret.txt"), "must never be readable").catch(() => {});

let browser;
try {
  try {
    browser = await puppeteer.launch({ channel: "chrome", headless: true });
  } catch (cause) {
    console.log(`SKIP: Chrome unavailable (${cause instanceof Error ? cause.message.split("\n")[0] : cause})`);
    process.exit(0);
  }
  const page = await browser.newPage();
  await page.setContent(
    "<h1>Muse Invoice 2026-06</h1><p>Total due: 123,450 KRW for the Quantum Flux subscription.</p>"
  );
  const pdf = await page.pdf({ format: "A4" });
  await browser.close();
  browser = undefined;

  const { mkdir } = await import("node:fs/promises");
  await mkdir(downloads, { recursive: true });
  await writeFile(join(downloads, "muse-invoice-2026-06.pdf"), pdf);
  await writeFile(join(downloads, "notes-old.md"), "# Old\nstale");

  console.log("1) pdfjs extraction over a REAL Chrome-generated PDF");
  const text = await extractPdfTextWithPdfjs(Buffer.from(pdf));
  assert(text.includes("Quantum Flux"), "extracted text contains the document body");
  assert(text.includes("123,450"), "extracted text keeps the literal amount");

  console.log("2) file_read tool — name-fragment resolution + read");
  const tool = createFileReadTool({ roots: [downloads] });
  const ctx = { runId: "r", userId: "verify" };
  const out = await tool.execute({ file: "invoice pdf" }, ctx);
  assert(out.read === true, "fragment 'invoice pdf' resolved to the PDF");
  assert(String(out.text).includes("Quantum Flux"), "tool returned the PDF text");

  console.log("2b) content-sniff — a no-extension file with text bytes reads (extension-only would refuse)");
  await writeFile(join(downloads, "meeting-notes"), "Q3 roadmap: ship the Quantum Flux integration by August.");
  const noExt = await tool.execute({ file: "meeting-notes" }, ctx);
  assert(noExt.read === true && String(noExt.text).includes("Quantum Flux"), "extensionless text file read via content-sniff");

  console.log("2c) content-sniff — a .txt that is REALLY a PDF routes through the extractor");
  await writeFile(join(downloads, "scan.txt"), pdf); // real PDF bytes under a .txt name
  const mislabeled = await tool.execute({ file: "scan.txt" }, ctx);
  assert(mislabeled.read === true && String(mislabeled.text).includes("Quantum Flux"), "mislabeled .txt-is-PDF extracted as PDF");

  console.log("3) fail-closed bounds");
  const outside = await tool.execute({ file: join(dir, "outside-secret.txt") }, ctx);
  assert(outside.read === false, "absolute path outside the roots is refused");
  const missing = await tool.execute({ file: "tax-return-9999" }, ctx);
  assert(missing.read === false && Array.isArray(missing.recent), "unmatched name lists recent files, reads nothing");

  console.log("\neval:file-read PASS");
} finally {
  if (browser) await browser.close().catch(() => {});
  await rm(dir, { force: true, recursive: true });
}
