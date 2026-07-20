import { describe, expect, it } from "vitest";

import type { MacCommandResult } from "./macos-exec.js";
import {
  APPLE_NOTES_MIRROR_ENV,
  DEFAULT_MAX_NOTE_BODY_CHARS,
  buildMirrorNoteScript,
  escapeNoteBodyHtml,
  isAppleNotesMirrorEnabled,
  mirrorNoteToApple,
  noteBodyToHtml,
  type MirrorableNote
} from "./macos-notes-mirror.js";

const ok = (stdout = ""): MacCommandResult => ({ exitCode: 0, stderr: "", stdout, timedOut: false });
const on = { [APPLE_NOTES_MIRROR_ENV]: "true" } as Record<string, string | undefined>;

const NOTE: MirrorableNote = { title: "Q3 launch plan", body: "line one\nline two" };

describe("isAppleNotesMirrorEnabled — the opt-in gate", () => {
  it("is OFF when the env var is absent", () => {
    expect(isAppleNotesMirrorEnabled({})).toBe(false);
  });
  it("is OFF for every falsy value", () => {
    for (const v of ["false", "0", "no", "off", "", "  ", "maybe"]) {
      expect(isAppleNotesMirrorEnabled({ [APPLE_NOTES_MIRROR_ENV]: v })).toBe(false);
    }
  });
  it("is ON for every truthy value, case/space-insensitive", () => {
    for (const v of ["true", "1", "yes", "on", "TRUE", " On "]) {
      expect(isAppleNotesMirrorEnabled({ [APPLE_NOTES_MIRROR_ENV]: v })).toBe(true);
    }
  });
});

describe("mirrorNoteToApple — consent pin (zero exec when off)", () => {
  it("makes ZERO osascript calls when the env var is absent", async () => {
    let called = 0;
    const exec = async (): Promise<MacCommandResult> => { called += 1; return ok(); };
    const result = await mirrorNoteToApple(NOTE, { env: {}, exec });
    expect(called).toBe(0);
    expect(result).toEqual({ mirrored: false, skipped: true });
  });
  it("makes ZERO osascript calls when the env var is explicitly false", async () => {
    let called = 0;
    const exec = async (): Promise<MacCommandResult> => { called += 1; return ok(); };
    const result = await mirrorNoteToApple(NOTE, { env: { [APPLE_NOTES_MIRROR_ENV]: "false" }, exec });
    expect(called).toBe(0);
    expect(result.skipped).toBe(true);
  });
});

describe("mirrorNoteToApple — opted-in create", () => {
  it("spawns one make-new-note script with the title + HTML body", async () => {
    const scripts: string[] = [];
    let argsSeen: readonly string[] | undefined;
    const exec = async (script: string, args?: readonly string[]): Promise<MacCommandResult> => {
      scripts.push(script);
      argsSeen = args;
      return ok();
    };
    const result = await mirrorNoteToApple(NOTE, { env: on, exec });
    expect(result.mirrored).toBe(true);
    expect(scripts).toHaveLength(1);
    const script = scripts[0]!;
    expect(script).toContain('tell application "Notes"');
    expect(script).toContain("make new note with properties {");
    // Title/body travel as argv; the HTML rendering of the body is unchanged.
    expect(argsSeen?.[0]).toBe("Q3 launch plan");
    expect(argsSeen?.[1]).toBe("line one<br>line two");
    expect(script).not.toContain("Q3 launch plan");
  });

  it("targets a named folder when one is supplied", async () => {
    const scripts: string[] = [];
    let argsSeen: readonly string[] | undefined;
    const exec = async (script: string, args?: readonly string[]): Promise<MacCommandResult> => {
      scripts.push(script);
      argsSeen = args;
      return ok();
    };
    await mirrorNoteToApple(NOTE, { env: on, exec, folder: "Muse" });
    expect(scripts[0]!).toContain("make new note at folder targetFolder with properties");
    expect(argsSeen?.[2]).toBe("Muse");
  });

  it("skips (no exec) when the title is blank", async () => {
    let called = 0;
    const exec = async (): Promise<MacCommandResult> => { called += 1; return ok(); };
    const result = await mirrorNoteToApple({ title: "   ", body: "x" }, { env: on, exec });
    expect(called).toBe(0);
    expect(result.warning).toContain("empty note title");
  });
});

describe("noteBodyToHtml / escapeNoteBodyHtml — the multiline + HTML-escape layer", () => {
  it("HTML-escapes the ampersand FIRST so entities aren't double-escaped", () => {
    expect(escapeNoteBodyHtml("a & b")).toBe("a &amp; b");
    expect(escapeNoteBodyHtml("<tag>")).toBe("&lt;tag&gt;");
    expect(escapeNoteBodyHtml('say "hi"')).toBe("say &quot;hi&quot;");
  });

  it("converts every newline flavour (\\n, \\r\\n, \\r) to <br>, preserving line structure", () => {
    expect(noteBodyToHtml("a\nb\r\nc\rd")).toBe("a<br>b<br>c<br>d");
  });

  it("shows a user-typed <br> literally (escaped) but a REAL newline as a break", () => {
    // The typed "<br>" is escaped to &lt;br&gt;; the real newline becomes <br>.
    expect(noteBodyToHtml("keep <br> literal\nnew line")).toBe("keep &lt;br&gt; literal<br>new line");
  });
});

describe("buildMirrorNoteScript — HTML injection is inert", () => {
  it("renders a </body><script> body payload as escaped text, never live markup", () => {
    // HTML escaping is a CONTENT concern (Notes renders the body as markup) and
    // is unaffected by the argv change — assert it on the value now passed.
    const { args } = buildMirrorNoteScript({ title: "t", body: "</body><script>alert(1)</script>" });
    const body = args[1]!;
    expect(body).toBe("&lt;/body&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(body).not.toContain("<script>");
    expect(body).not.toContain("</body>");
  });
});

describe("buildMirrorNoteScript — AppleScript injection safety (structural invariant)", () => {
  const hostilePayloads: ReadonlyArray<{ name: string; text: string }> = [
    { name: "quote-and-tell", text: '"; tell app "Finder" to delete every item; "' },
    { name: "backslash", text: 'a\\"; do shell script "rm -rf ~"; "' },
    { name: "newline-break", text: "line one\n  end tell\n  tell application \"Finder\" to empty trash\n" },
    { name: "carriage-return", text: "a\r end tell \r tell app \"System Events\"" },
    { name: "korean-emoji", text: '엄마 메모 📞 "; delete; "' }
  ];

  // The title and body reach osascript as argv items — Apple documents these as
  // "a list of strings to the direct parameter of the run handler"
  // (osascript(1)) — so neither is ever part of the script source. The
  // invariant is no longer "the escaper produced a well-formed literal" but the
  // stronger "there is no literal to malform".
  for (const { name, text } of hostilePayloads) {
    it(`keeps ${name} out of the script source when in the title`, () => {
      const { args, script } = buildMirrorNoteScript({ title: text, body: "safe" });
      expect(args[0]).toBe(text);
      expect(script).not.toContain(text);
      expect(script).not.toMatch(/tell app(lication)? "Finder"/u);
      expect(script).not.toContain("rm -rf");
    });
    it(`keeps ${name} out of the script source when in the body`, () => {
      const { args, script } = buildMirrorNoteScript({ title: "safe", body: text });
      // The body is HTML-escaped for Notes' renderer before it becomes an argv
      // item, so the payload's quotes arrive as `&quot;` — still pure data, and
      // still absent from the script source, which is what matters here.
      const body = args[1]!;
      expect(body.length).toBeGreaterThan(0);
      expect(body).not.toContain('"');
      expect(script).not.toContain(text);
      expect(script).not.toContain(body);
      expect(script).not.toMatch(/tell app(lication)? "Finder"/u);
      expect(script).not.toContain("rm -rf");
    });
  }

  it("the script is byte-identical across wildly different payloads", () => {
    const a = buildMirrorNoteScript({ title: "plan", body: "safe" }).script;
    const b = buildMirrorNoteScript({ title: hostilePayloads[0]!.text, body: hostilePayloads[1]!.text }).script;
    expect(a).toBe(b);
  });

  it("a hostile Finder-delete body payload reaches osascript as an argument", async () => {
    const calls: Array<{ script: string; args: readonly string[] | undefined }> = [];
    const exec = async (script: string, args?: readonly string[]): Promise<MacCommandResult> => {
      calls.push({ args, script });
      return ok();
    };
    await mirrorNoteToApple(
      { title: "t", body: '"; tell application "Finder" to delete every item of home; "' },
      { env: on, exec }
    );
    expect(calls[0]?.script).not.toContain("Finder");
    expect(calls[0]?.args?.[1]).toContain("Finder");
  });
});


describe("mirrorNoteToApple — body cap", () => {
  it("truncates an over-cap body and appends the truncation marker", async () => {
    let argsSeen: readonly string[] | undefined;
    const exec = async (_script: string, args?: readonly string[]): Promise<MacCommandResult> => { argsSeen = args; return ok(); };
    const huge = "x".repeat(DEFAULT_MAX_NOTE_BODY_CHARS + 5_000);
    await mirrorNoteToApple({ title: "big", body: huge }, { env: on, exec });
    const body = argsSeen?.[1] ?? "";
    expect(body).toContain("truncated by Muse");
    // The original (uncapped) length never reaches osascript.
    expect(body).not.toContain("x".repeat(DEFAULT_MAX_NOTE_BODY_CHARS + 1));
  });

  it("does NOT truncate a body at or under the cap", async () => {
    const scripts: string[] = [];
    const exec = async (script: string): Promise<MacCommandResult> => { scripts.push(script); return ok(); };
    await mirrorNoteToApple({ title: "small", body: "just a line" }, { env: on, exec, maxBodyChars: 100 });
    expect(scripts[0]!).not.toContain("truncated by Muse");
  });
});

describe("mirrorNoteToApple — Korean + emoji round-trip", () => {
  it("preserves Korean and emoji verbatim in the generated body", async () => {
    let argsSeen: readonly string[] | undefined;
    const exec = async (_script: string, args?: readonly string[]): Promise<MacCommandResult> => { argsSeen = args; return ok(); };
    await mirrorNoteToApple({ title: "메모 제목", body: "오늘 회의 요약 📝\n다음 주 계획 🚀" }, { env: on, exec });
    // Unicode survives the argv boundary byte-for-byte — osascript(1) passes
    // arguments as strings, so no escaping can mangle Hangul or emoji.
    expect(argsSeen?.[0]).toBe("메모 제목");
    expect(argsSeen?.[1]).toBe("오늘 회의 요약 📝<br>다음 주 계획 🚀");
  });
});

describe("mirrorNoteToApple — fail-soft", () => {
  it("returns a warning (never throws) when osascript exits non-zero", async () => {
    const exec = async (): Promise<MacCommandResult> => ({ exitCode: 1, stderr: "boom", stdout: "", timedOut: false });
    const result = await mirrorNoteToApple(NOTE, { env: on, exec });
    expect(result.mirrored).toBe(false);
    expect(result.warning).toContain("Apple Notes mirror failed");
    expect(result.warning).toContain("boom");
  });

  it("maps a -1743 permission error to an actionable warning", async () => {
    const exec = async (): Promise<MacCommandResult> => ({
      exitCode: 1,
      stderr: "execution error: Not authorised to send Apple events (-1743)",
      stdout: "",
      timedOut: false
    });
    const result = await mirrorNoteToApple(NOTE, { env: on, exec });
    expect(result.warning).toContain("Automation permission denied");
  });

  it("returns a warning when the runner times out", async () => {
    const exec = async (): Promise<MacCommandResult> => ({ exitCode: null, stderr: "", stdout: "", timedOut: true });
    const result = await mirrorNoteToApple(NOTE, { env: on, exec });
    expect(result.mirrored).toBe(false);
    expect(result.warning).toContain("timed out");
  });

  it("returns a warning when the runner throws (spawn failure)", async () => {
    const exec = async (): Promise<MacCommandResult> => { throw new Error("ENOENT osascript"); };
    const result = await mirrorNoteToApple(NOTE, { env: on, exec });
    expect(result.mirrored).toBe(false);
    expect(result.warning).toContain("ENOENT osascript");
  });
});
