import { describe, expect, it } from "vitest";

import {
  bugReportUrl,
  commandErrorLine,
  commandFromArgv,
  formatCliError,
  isExpectedCliError
} from "./format-cli-error.js";

describe("commandFromArgv", () => {
  it("returns the first non-flag token after node + script", () => {
    expect(commandFromArgv(["node", "muse", "ask", "hello"])).toBe("ask");
    expect(commandFromArgv(["node", "muse", "--no-color", "today"])).toBe("today");
  });

  it("returns undefined when only flags were passed", () => {
    expect(commandFromArgv(["node", "muse", "--oops"])).toBeUndefined();
    expect(commandFromArgv(["node", "muse"])).toBeUndefined();
  });
});

describe("isExpectedCliError", () => {
  it("treats an API-unreachable error as expected", () => {
    const err = new Error("Muse API server is not running (tried http://x) — start it …");
    expect(isExpectedCliError(err)).toBe(true);
  });

  it("treats a plain Error with a message as expected (intentional user-facing throw)", () => {
    expect(isExpectedCliError(new Error("--image requires --local"))).toBe(true);
  });

  it("treats programmer-error subclasses as UNexpected (a real defect)", () => {
    expect(isExpectedCliError(new TypeError("x is undefined"))).toBe(false);
    expect(isExpectedCliError(new RangeError("out of range"))).toBe(false);
  });

  it("treats a message-less error as unexpected", () => {
    expect(isExpectedCliError(new Error(""))).toBe(false);
    expect(isExpectedCliError("boom")).toBe(false);
  });

  it("treats a JSON SyntaxError as EXPECTED (bad user JSON, not a Muse defect)", () => {
    let syntaxErr: unknown;
    try {
      JSON.parse("{");
    } catch (e) {
      syntaxErr = e;
    }
    expect(syntaxErr).toBeInstanceOf(SyntaxError);
    expect(isExpectedCliError(syntaxErr)).toBe(true);
  });
});

describe("formatCliError", () => {
  it("API-unreachable → one clean line with the next-step hint, no bug URL", () => {
    const err = new Error(
      "Muse API server is not running (tried http://127.0.0.1:3030) — this command needs it. Start it with `pnpm --filter @muse/api dev`."
    );
    const out = formatCliError(err, { command: "cost", version: "0.9.9" });
    expect(out.startsWith("muse: Muse API server is not running")).toBe(true);
    expect(out).toContain("Start it with");
    expect(out).not.toContain("github.com/wlsdks/Muse/issues");
    expect(out.endsWith("\n")).toBe(true);
  });

  it("intentional user-facing throw → clean line, no bug URL", () => {
    const out = formatCliError(new Error("--stream requires remote API chat; omit --local"));
    expect(out).toBe("muse: --stream requires remote API chat; omit --local\n");
  });

  it("JSON SyntaxError → clean fix-it line, NO bug-report URL", () => {
    let syntaxErr: unknown;
    try {
      JSON.parse("{");
    } catch (e) {
      syntaxErr = e;
    }
    const out = formatCliError(syntaxErr, { command: "mcp", version: "0.9.9" });
    expect(out.startsWith("muse: invalid JSON — ")).toBe(true);
    expect(out).not.toContain("github.com/wlsdks/Muse/issues");
    expect(out.endsWith("\n")).toBe(true);
  });

  it("unexpected (TypeError) → message + bug-report URL carrying version + command", () => {
    const out = formatCliError(new TypeError("Cannot read properties of undefined"), {
      command: "ask",
      version: "1.2.3"
    });
    expect(out).toContain("muse: Cannot read properties of undefined");
    expect(out).toContain("unexpected error in Muse (v1.2.3)");
    expect(out).toContain("https://github.com/wlsdks/Muse/issues/new?");
    // the URL body carries the version + command
    const url = out.split("\n").find((line) => line.includes("issues/new")) ?? "";
    // URLSearchParams encodes spaces as '+'; normalise before asserting.
    const decoded = decodeURIComponent(url).replace(/\+/g, " ");
    expect(decoded).toContain("muse ask");
    expect(decoded).toContain("1.2.3");
  });
});

describe("commandErrorLine", () => {
  it("produces the canonical `muse <cmd>: <message>` line, newline-terminated, no bug URL", () => {
    expect(commandErrorLine("import", "Bundle not found: /x.tar.gz")).toBe("muse import: Bundle not found: /x.tar.gz\n");
    expect(commandErrorLine("bg logs", "No background process with id 'bg-1'.")).toBe("muse bg logs: No background process with id 'bg-1'.\n");
  });

  it("shares the same `muse <cmd>:` prefix shape the top-level formatter emits (consistency)", () => {
    const line = commandErrorLine("ingest", "boom");
    expect(line.startsWith("muse ingest: ")).toBe(true);
    expect(line).not.toContain("github.com");
    expect(line.endsWith("\n")).toBe(true);
  });
});

describe("bugReportUrl", () => {
  it("prefills title + body with the command, version and error", () => {
    const url = bugReportUrl("something broke", { command: "today", version: "0.1.0" });
    const decoded = decodeURIComponent(url).replace(/\+/g, " ");
    expect(url.startsWith("https://github.com/wlsdks/Muse/issues/new?")).toBe(true);
    expect(decoded).toContain("[bug] muse today: something broke");
    expect(decoded).toContain("0.1.0");
    expect(decoded).toContain("something broke");
  });

  it("redacts secret-shaped error text before pre-filling the external issue URL", () => {
    const token = `sk-proj-${"a".repeat(32)}`;
    const url = bugReportUrl(
      `TypeError: upstream rejected ${token} at https://example.test/api?api_key=calendar-secret`,
    );
    const decoded = decodeURIComponent(url).replace(/\+/g, " ");

    expect(decoded).not.toContain(token);
    expect(decoded).not.toContain("calendar-secret");
    expect(decoded).toContain("[redacted-openai-key]");
    expect(decoded).toContain("[redacted-url-credential]");
  });

  it("redacts secret-shaped command and version values at the external URL boundary", () => {
    const token = `sk-proj-${"b".repeat(32)}`;
    const url = bugReportUrl("boom", { command: `ask ${token}`, version: token });
    const decoded = decodeURIComponent(url).replace(/\+/g, " ");

    expect(decoded).not.toContain(token);
    expect(decoded).toContain("[redacted-openai-key]");
  });
});
