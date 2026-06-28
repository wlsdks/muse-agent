import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readNoteProvenance, recordIngestedNote, untrustedNotePaths } from "./note-provenance.js";

const file = () => join(mkdtempSync(join(tmpdir(), "muse-note-prov-")), "note-provenance.json");

describe("note-provenance — externally-ingested notes are recorded so recall can tag them untrusted (GROUNDED≠TRUE note-veracity)", () => {
  it("records + round-trips a URL-ingested note's provenance", async () => {
    const f = file();
    await recordIngestedNote(f, { ingestedAt: "2026-06-21T00:00:00.000Z", path: "web/acme.md", sourceUrl: "https://evil.example/acme" });
    const got = await readNoteProvenance(f);
    expect(got).toEqual([{ ingestedAt: "2026-06-21T00:00:00.000Z", path: "web/acme.md", sourceUrl: "https://evil.example/acme" }]);
  });

  it("upserts by path — re-ingesting the same path keeps ONE entry (newest wins)", async () => {
    const f = file();
    await recordIngestedNote(f, { ingestedAt: "2026-06-20T00:00:00.000Z", path: "web/x.md", sourceUrl: "https://a" });
    await recordIngestedNote(f, { ingestedAt: "2026-06-21T00:00:00.000Z", path: "web/x.md", sourceUrl: "https://b" });
    const got = await readNoteProvenance(f);
    expect(got).toHaveLength(1);
    expect(got[0]?.sourceUrl).toBe("https://b");
  });

  it("untrustedNotePaths yields exactly the ingested note paths (a user-authored note has no entry → trusted)", async () => {
    const f = file();
    await recordIngestedNote(f, { ingestedAt: "t", path: "web/a.md", sourceUrl: "https://a" });
    await recordIngestedNote(f, { ingestedAt: "t", path: "web/b.md", sourceUrl: "https://b" });
    const set = untrustedNotePaths(await readNoteProvenance(f));
    expect(set.has("web/a.md")).toBe(true);
    expect(set.has("web/b.md")).toBe(true);
    expect(set.has("my-own-note.md")).toBe(false);
  });

  it("tolerates a missing / corrupt / wrong-shape file (→ [])", async () => {
    const { writeFileSync } = await import("node:fs");
    expect(await readNoteProvenance(join(tmpdir(), "muse-missing-prov.json"))).toEqual([]);
    const bad = file();
    writeFileSync(bad, "not json", "utf8");
    expect(await readNoteProvenance(bad)).toEqual([]);
    const wrong = file();
    writeFileSync(wrong, JSON.stringify({ wrongKey: 1 }), "utf8");
    expect(await readNoteProvenance(wrong)).toEqual([]);
  });
});

describe("note-provenance — atomic write (the citation-provenance ledger can't be corrupted mid-write)", () => {
  it("leaves NO .tmp-* orphan and a complete valid-JSON file after a write (atomicWriteFile temp+rename)", async () => {
    const { readdirSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    const f = file();
    await recordIngestedNote(f, { path: "a.md", sourceUrl: "https://x.test/a", ingestedAt: "2026-06-28T00:00:00Z" });
    const dir = dirname(f);
    expect(readdirSync(dir).some((n) => n.includes(".tmp-"))).toBe(false); // no leftover temp
    const back = await readNoteProvenance(f);
    expect(back.map((e) => e.path)).toEqual(["a.md"]); // round-trips intact
  });

  it("stays a single complete valid-JSON file under concurrent writes (never a torn/partial write)", async () => {
    const { readFileSync } = await import("node:fs");
    const f = file();
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        recordIngestedNote(f, { path: `n${i.toString()}.md`, sourceUrl: `https://x.test/${i.toString()}`, ingestedAt: "2026-06-28T00:00:00Z" })
      )
    );
    // The file must ALWAYS parse to a well-formed { notes: [...] } — a raw non-atomic
    // writeFile racing 12 ways could leave a truncated/interleaved JSON that throws here.
    const parsed = JSON.parse(readFileSync(f, "utf8"));
    expect(Array.isArray(parsed.notes)).toBe(true);
  });
});
