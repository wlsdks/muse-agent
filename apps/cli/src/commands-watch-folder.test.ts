import { describe, expect, it } from "vitest";

import { extractDueHint } from "./commands-watch-folder.js";

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
