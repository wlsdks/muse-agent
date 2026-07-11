import { describe, expect, it } from "vitest";

import { buildInboxNotice, extractDueHint, resolveInboxDueAt, watchIngestNoteId } from "./commands-watch-folder.js";

const FIXED_NOW = (): Date => new Date("2026-05-18T09:00:00Z");

// The resolver's documented default lands a bare day phrase at 09:00 SERVER-LOCAL
// (loopback-relative-time.ts header), so the expected instant must be computed
// with the same local-clock APIs — a hardcoded Z-rendering only holds in one TZ.
const localNineAm = (daysFromNow: number): string => {
  const d = new Date(FIXED_NOW());
  d.setDate(d.getDate() + daysFromNow);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
};

describe("watchIngestNoteId — corpus note id for an ingested watched file", () => {
  it("is <prefix>/<basename-no-ext>.md so the note is indexable by `muse ask`", () => {
    expect(watchIngestNoteId("garage.txt", "inbox")).toBe("inbox/garage.md");
    expect(watchIngestNoteId("report.pdf", "drops")).toBe("drops/report.md");
  });

  it("keeps an already-indexable extension and tolerates a slashed/empty prefix", () => {
    expect(watchIngestNoteId("note.md", "inbox")).toBe("inbox/note.md");
    expect(watchIngestNoteId("a.txt", "/inbox/")).toBe("inbox/a.md");
    expect(watchIngestNoteId("a.txt", "")).toBe("a.md");
  });
});

describe("extractDueHint (watch-folder --as-task due parsing)", () => {
  it("extracts a hint from a `due:` / `deadline:` / `due -` line (case-insensitive)", () => {
    expect(extractDueHint("due: tomorrow")).toBe("tomorrow");
    expect(extractDueHint("DUE - 2026-05-20")).toBe("2026-05-20");
    expect(extractDueHint("deadline: friday at 5pm")).toBe("friday at 5pm");
    expect(extractDueHint("   deadline:   next monday  ")).toBe("next monday");
  });

  it("recognises the Korean 마감 keyword", () => {
    expect(extractDueHint("마감: 내일")).toBe("내일");
  });

  it("is keyword-anchored — not any 'due' substring mid-line", () => {
    expect(extractDueHint("the report is due: tomorrow")).toBeUndefined();
    // "Due Date:" is NOT "due:" — only the exact keyword + separator.
    expect(extractDueHint("Due Date: 2026-01-01")).toBeUndefined();
  });

  it("scans only the first 8 lines and takes the first match", () => {
    expect(extractDueHint(`${Array(8).fill("x").join("\n")}\ndue: late`)).toBeUndefined();
    expect(extractDueHint(`${Array(7).fill("x").join("\n")}\ndue: ontime`)).toBe("ontime");
    expect(extractDueHint("due: first\ndeadline: second")).toBe("first");
  });

  it("returns undefined for an empty value or no keyword", () => {
    expect(extractDueHint("due:")).toBeUndefined();
    expect(extractDueHint("just some notes\nno hint here")).toBeUndefined();
    expect(extractDueHint("")).toBeUndefined();
  });
});

describe("buildInboxNotice — text preview vs binary blob (no mojibake notices)", () => {
  it("previews a text file's first non-empty line", () => {
    const buf = Buffer.from("\n\n  Pay the electricity bill\nsecond line\n", "utf8");
    const notice = buildInboxNotice("bill.txt", buf, 10_240);
    expect(notice.binary).toBe(false);
    expect(notice.title).toBe("bill");
    expect(notice.text).toBe("📥 bill: Pay the electricity bill");
    expect(notice.body).toContain("Pay the electricity bill");
  });

  it("treats a PNG (or any blob with NUL bytes) as binary — clean filename+size line, empty body", () => {
    // PNG magic + a NUL byte → isLikelyBinary.
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]);
    const notice = buildInboxNotice("photo.png", buf, 10_240);
    expect(notice.binary).toBe(true);
    expect(notice.title).toBe("photo");
    expect(notice.text).toBe("📎 photo: png file (11 bytes) — binary, no text preview");
    // Critical: no garbage spills into the body (task notes / due-hint parsing).
    expect(notice.body).toBe("");
  });

  it("an extensionless binary still gets a sane label", () => {
    const buf = Buffer.from([0x00, 0x00, 0xff, 0xfe, 0x00]);
    const notice = buildInboxNotice("blob", buf, 10_240);
    expect(notice.binary).toBe(true);
    expect(notice.text).toContain("blob: binary file");
  });

  it("truncates the preview to maxPreviewBytes for a large text file", () => {
    const big = "A".repeat(50_000);
    const notice = buildInboxNotice("big.log", Buffer.from(big, "utf8"), 1_024);
    expect(notice.binary).toBe(false);
    expect(notice.body.length).toBe(1_024);
  });
});

describe("resolveInboxDueAt (watch-folder --as-task dueAt resolution)", () => {
  it("uses the parsed hint when the due: line is understood", () => {
    expect(resolveInboxDueAt("due: next monday", 60, FIXED_NOW)).toEqual({
      dueAt: localNineAm(7)
    });
    expect(resolveInboxDueAt("마감: 내일", 60, FIXED_NOW)).toEqual({
      dueAt: localNineAm(1)
    });
  });

  it("surfaces the unparsed hint instead of silently degrading on a typo", () => {
    expect(resolveInboxDueAt("due: next freday", 60, FIXED_NOW)).toEqual({
      dueAt: "2026-05-18T10:00:00.000Z",
      unparsedHint: "next freday"
    });
    expect(resolveInboxDueAt("due: zzz qqq", 30, FIXED_NOW)).toEqual({
      dueAt: "2026-05-18T09:30:00.000Z",
      unparsedHint: "zzz qqq"
    });
  });

  it("falls back to now + defaultLeadMinutes with no hint flagged when absent", () => {
    expect(resolveInboxDueAt("just notes\nmore notes", 60, FIXED_NOW)).toEqual({
      dueAt: "2026-05-18T10:00:00.000Z"
    });
    expect(resolveInboxDueAt("", 90, FIXED_NOW)).toEqual({
      dueAt: "2026-05-18T10:30:00.000Z"
    });
  });
});
