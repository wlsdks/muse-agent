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
import { crc32, deflateRawSync } from "node:zlib";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import puppeteer from "../packages/browser/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js";

import { createFileReadTool, extractDocxTextWithMammoth, extractPdfTextWithPdfjs } from "../packages/fs/dist/index.js";

function assert(condition, label) {
  if (!condition) throw new Error(`ASSERT FAILED: ${label}`);
  console.log(`  ✓ ${label}`);
}

// Minimal ZIP writer (DEFLATE) — enough to build a real .docx without a dep,
// so the docx round-trip stays self-contained (no committed binary fixture).
function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const comp = deflateRawSync(data);
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, comp);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(0, 12);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + comp.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, end]);
}

function buildDocx(text) {
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  return buildZip([
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes) },
    { name: "_rels/.rels", data: Buffer.from(rels) },
    { name: "word/document.xml", data: Buffer.from(documentXml) }
  ]);
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
  const tool = createFileReadTool({ roots: [downloads], baseDir: dir, docRoots: [downloads] });
  const ctx = { runId: "r", userId: "verify" };
  const out = await tool.execute({ path: "invoice pdf" }, ctx);
  assert(out.read === true, "fragment 'invoice pdf' resolved to the PDF");
  assert(String(out.text).includes("Quantum Flux"), "tool returned the PDF text");

  console.log("2b) content-sniff — a no-extension file with text bytes reads (extension-only would refuse)");
  await writeFile(join(downloads, "meeting-notes"), "Q3 roadmap: ship the Quantum Flux integration by August.");
  const noExt = await tool.execute({ path: "meeting-notes" }, ctx);
  assert(noExt.read === true && String(noExt.text).includes("Quantum Flux"), "extensionless text file read via content-sniff");

  console.log("2c) content-sniff — a .txt that is REALLY a PDF routes through the extractor");
  await writeFile(join(downloads, "scan.txt"), pdf); // real PDF bytes under a .txt name
  const mislabeled = await tool.execute({ path: "scan.txt" }, ctx);
  assert(mislabeled.read === true && String(mislabeled.text).includes("Quantum Flux"), "mislabeled .txt-is-PDF extracted as PDF");

  console.log("2d) REAL .docx — mammoth extraction + tool round-trip");
  const docxBytes = buildDocx("Quarterly review: revenue up 18 percent, hiring frozen until Q3.");
  const docxText = await extractDocxTextWithMammoth(docxBytes);
  assert(docxText.includes("revenue up 18 percent"), "mammoth extracted text from a real generated .docx");
  await writeFile(join(downloads, "quarterly-review.docx"), docxBytes);
  const docxOut = await tool.execute({ path: "quarterly-review" }, ctx);
  assert(docxOut.read === true && String(docxOut.text).includes("hiring frozen"), "file_read read the .docx end-to-end");

  console.log("2e) REAL symlink escape — a link under Downloads pointing outside the roots is refused");
  const { symlink, writeFile: wf } = await import("node:fs/promises");
  const secret = join(dir, "outside-secret.txt"); // already written, outside `downloads`
  await wf(secret, "TOP SECRET — must never be read via file_read").catch(() => {});
  const linkPath = join(downloads, "innocent.txt");
  let linkMade = true;
  await symlink(secret, linkPath).catch(() => { linkMade = false; });
  if (linkMade) {
    const escapeOut = await tool.execute({ path: "innocent" }, ctx);
    assert(escapeOut.read === false, "a symlink escaping the roots is refused (realpath guard)");
    assert(!String(escapeOut.text ?? "").includes("TOP SECRET"), "the link target's content was NOT returned");
  } else {
    console.log("  ⚠ symlink creation unsupported here — skipping the live symlink case");
  }

  console.log("2f) IMAGE — file_read routes an image to the injected vision callback");
  const { writeFile: wfi } = await import("node:fs/promises");
  await wfi(join(downloads, "snap.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));
  let sawMime = "";
  const imgTool = createFileReadTool({
    roots: [downloads], baseDir: dir, docRoots: [downloads],
    describeImage: async (input) => { sawMime = input.mimeType; return { ok: true, text: "A scanned receipt for two coffees." }; }
  });
  const imgOut = await imgTool.execute({ path: "snap" }, ctx);
  assert(imgOut.read === true && String(imgOut.text).includes("receipt"), "image routed to vision and described");
  assert(sawMime === "image/png", "image mime type derived from the .png extension");
  const noVision = await createFileReadTool({ roots: [downloads], baseDir: dir, docRoots: [downloads] }).execute({ path: "snap" }, ctx);
  assert(noVision.read === false, "an image is refused when no vision model is wired");

  console.log("3) fail-closed bounds");
  const outside = await tool.execute({ path: join(dir, "outside-secret.txt") }, ctx);
  assert(outside.read === false, "absolute path outside the roots is refused");
  const missing = await tool.execute({ path: "tax-return-9999" }, ctx);
  assert(missing.read === false && Array.isArray(missing.recent), "unmatched name lists recent files, reads nothing");

  console.log("\neval:file-read PASS");
} finally {
  if (browser) await browser.close().catch(() => {});
  await rm(dir, { force: true, recursive: true });
}
