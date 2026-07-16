import { describe, expect, it } from "vitest";

import { tsToIso } from "../src/slack-provider.js";

describe("tsToIso (Slack ts → ISO conversion on the fetchInbound path)", () => {
  it("converts a normal Slack ts to ISO-8601 millisecond precision", () => {
    expect(tsToIso("1700000000.123456")).toBe(new Date(1700000000123).toISOString());
  });

  it("falls back to the raw ts when parsing fails (empty / non-numeric)", () => {
    expect(tsToIso("")).toBe("");
    expect(tsToIso("not-a-number")).toBe("not-a-number");
    expect(tsToIso("NaN")).toBe("NaN");
  });

  it("falls back when ts is 0 or negative (Slack ships 0 in pathological cases)", () => {
    expect(tsToIso("0")).toBe("0");
    expect(tsToIso("-1.0")).toBe("-1.0");
  });

  it("falls back when seconds is Infinity (parseFloat accepts the token)", () => {
    expect(tsToIso("Infinity")).toBe("Infinity");
  });

  it("rejects a numeric prefix with trailing junk instead of silently advancing a malformed cursor", () => {
    expect(tsToIso("1700000000.123456garbage")).toBe("1700000000.123456garbage");
  });

  it("falls back when seconds*1000 exceeds the maximum Date value (would throw RangeError) — defends fetchInbound from a poisoned ts crashing the whole batch", () => {
    const beyondMaxDate = "9999999999999999";
    expect(Number.isFinite(new Date(Number.parseFloat(beyondMaxDate) * 1000).getTime())).toBe(false);
    expect(tsToIso(beyondMaxDate)).toBe(beyondMaxDate);
  });
});
