import { describe, expect, it } from "vitest";

import type { MacCommandResult } from "./macos-exec.js";
import {
  APPLE_CONTACTS_IMPORT_CAP,
  buildReadAppleContactsScript,
  normalizeAppleBirthday,
  parseAppleContactsPayload,
  readAppleContacts
} from "./macos-contacts-import.js";

const RS = String.fromCharCode(30);
const US = String.fromCharCode(31);
const GS = String.fromCharCode(29);

/** Encode one record the way the AppleScript payload does. */
function rec(name: string, org: string, bday: string, phones: readonly string[], emails: readonly string[]): string {
  const phs = phones.length > 0 ? phones.join(GS) + GS : "";
  const ems = emails.length > 0 ? emails.join(GS) + GS : "";
  return [name, org, bday, phs, ems].join(US) + RS;
}

const ok = (stdout: string): MacCommandResult => ({ exitCode: 0, stderr: "", stdout, timedOut: false });

describe("parseAppleContactsPayload", () => {
  it("parses a normal multi-field record", () => {
    const payload = rec("Jane Kim", "Acme", "1990-3-7", ["+1 415-555-0101", "+1 415 555 0102"], ["jane@acme.com"]);
    expect(parseAppleContactsPayload(payload)).toEqual([
      {
        birthday: "1990-03-07",
        emails: ["jane@acme.com"],
        name: "Jane Kim",
        organization: "Acme",
        phones: ["+1 415-555-0101", "+1 415 555 0102"]
      }
    ]);
  });

  it("survives hostile names — quotes, `\"; end tell`, commas, tab, newline, Korean+emoji — without breaking fields", () => {
    const hostile = `"; end tell drop table\t김철수 🎉, "quoted"`;
    const payload = rec(hostile, "", "", ["5551234567"], []);
    const parsed = parseAppleContactsPayload(payload);
    expect(parsed).toHaveLength(1);
    // Tab (0x09) and LF (0x0a) survive stripUntrustedTerminalChars; the name is intact
    // aside from the outer trim. No field bled into another.
    expect(parsed[0]!.name).toContain("end tell");
    expect(parsed[0]!.name).toContain("김철수");
    expect(parsed[0]!.name).toContain("🎉");
    expect(parsed[0]!.phones).toEqual(["5551234567"]);
    expect(parsed[0]!.organization).toBeUndefined();
  });

  it("strips a residual delimiter/control char smuggled inside a value (never mis-splits across it)", () => {
    // A value that somehow carried a raw US/GS byte: it is stripped, not treated as structure,
    // once it lands inside a field. (Real Contacts values can't carry these, but the parser is defensive.)
    const payload = `Bob${US}${US}${US}${US}alice${GS}bob@x.com` + RS;
    const parsed = parseAppleContactsPayload(payload);
    // "alice" has no @, still a value; the point: no throw, name is clean "Bob".
    expect(parsed[0]!.name).toBe("Bob");
  });

  it("drops records with an empty name and de-duplicates repeated phone/email values", () => {
    const payload = rec("", "", "", ["5551230000"], []) + rec("Sam", "", "", ["5551239999", "5551239999"], ["s@x.com", "S@X.com"]);
    const parsed = parseAppleContactsPayload(payload);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.name).toBe("Sam");
    expect(parsed[0]!.phones).toEqual(["5551239999"]);
    expect(parsed[0]!.emails).toEqual(["s@x.com", "S@X.com"]);
  });

  it("returns [] on empty payload", () => {
    expect(parseAppleContactsPayload("")).toEqual([]);
    expect(parseAppleContactsPayload(RS)).toEqual([]);
  });
});

describe("normalizeAppleBirthday", () => {
  it("keeps a real year as YYYY-MM-DD", () => {
    expect(normalizeAppleBirthday("1985-12-3")).toBe("1985-12-03");
  });
  it("maps a no-year sentinel (year < 1900, e.g. 1604) to MM-DD", () => {
    expect(normalizeAppleBirthday("1604-2-29")).toBe("02-29");
    expect(normalizeAppleBirthday("1-6-15")).toBe("06-15");
  });
  it("rejects a non-date / out-of-range value", () => {
    expect(normalizeAppleBirthday("")).toBeUndefined();
    expect(normalizeAppleBirthday("nope")).toBeUndefined();
    expect(normalizeAppleBirthday("1990-13-40")).toBeUndefined();
    expect(normalizeAppleBirthday("1990-02-29")).toBeUndefined();
    expect(normalizeAppleBirthday("1604-04-31")).toBeUndefined();
    expect(normalizeAppleBirthday("10000-01-01")).toBeUndefined();
  });

  it("accepts leap day only when a real supplied year is a leap year", () => {
    expect(normalizeAppleBirthday("2000-02-29")).toBe("2000-02-29");
    expect(normalizeAppleBirthday("1604-02-29")).toBe("02-29");
  });
});

describe("buildReadAppleContactsScript", () => {
  it("targets Contacts, iterates people, and interpolates the cap", () => {
    const script = buildReadAppleContactsScript(50);
    expect(script).toContain(`tell application "Contacts"`);
    expect(script).toContain("set maxN to 50");
    expect(script).toContain("birth date of p");
    expect(script).toContain("character id 30");
    expect(script).toContain("character id 31");
  });
  it("defaults the cap to APPLE_CONTACTS_IMPORT_CAP", () => {
    expect(buildReadAppleContactsScript()).toContain(`set maxN to ${APPLE_CONTACTS_IMPORT_CAP.toString()}`);
  });
});

describe("readAppleContacts — fail-soft", () => {
  it("returns parsed contacts on a successful read", async () => {
    const exec = async (): Promise<MacCommandResult> => ok(rec("Ann", "", "1970-1-2", ["5551112222"], []));
    const result = await readAppleContacts(exec);
    expect(result.ok).toBe(true);
    expect(result.contacts).toEqual([{ birthday: "1970-01-02", emails: [], name: "Ann", phones: ["5551112222"] }]);
  });

  it("maps a -1743 permission error to an actionable message (no throw)", async () => {
    const exec = async (): Promise<MacCommandResult> => ({ exitCode: 1, stderr: "execution error: Not authorized (-1743)", stdout: "", timedOut: false });
    const result = await readAppleContacts(exec);
    expect(result.ok).toBe(false);
    expect(result.contacts).toEqual([]);
    expect(result.error).toMatch(/Contacts access denied/u);
    expect(result.error).toMatch(/Privacy & Security/u);
  });

  it("reports a timeout without throwing", async () => {
    const exec = async (): Promise<MacCommandResult> => ({ exitCode: null, stderr: "", stdout: "", timedOut: true });
    const result = await readAppleContacts(exec);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out/u);
  });

  it("catches an osascript spawn throw as a clean error", async () => {
    const exec = async (): Promise<MacCommandResult> => { throw new Error("ENOENT osascript"); };
    const result = await readAppleContacts(exec);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/spawn failed/u);
  });

  it("treats an empty Contacts book as an ok read of zero contacts", async () => {
    const exec = async (): Promise<MacCommandResult> => ok("");
    const result = await readAppleContacts(exec);
    expect(result).toEqual({ contacts: [], ok: true });
  });
});
