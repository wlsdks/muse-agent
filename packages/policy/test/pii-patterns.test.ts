import { describe, expect, it } from "vitest";
import {
  allPiiPatterns,
  commonPiiPatterns,
  internationalPiiPatterns,
  krPiiPatterns,
  maskPii
} from "../src/index.js";

describe("PII patterns", () => {
  it("keeps specific patterns before common patterns", () => {
    expect(allPiiPatterns.map((pattern) => pattern.name)).toEqual([
      ...krPiiPatterns.map((pattern) => pattern.name),
      ...internationalPiiPatterns.map((pattern) => pattern.name),
      ...commonPiiPatterns.map((pattern) => pattern.name)
    ]);
  });

  it("masks representative private identifiers", () => {
    const result = maskPii(
      [
        "person@example.com",
        "010-1234-5678",
        "1234-5678-9012-3456",
        "192.168.1.100",
        "712020:fd33c992-4363-499e-b10a-d51ff76fcff2"
      ].join(" ")
    );

    expect(result.text).toContain("***@***.***");
    expect(result.text).toContain("***-****-****");
    expect(result.text).toContain("****-****-****-****");
    expect(result.text).toContain("***.***.***.***");
    expect(result.text).toContain("***:****-****-****-****-************");
  });

  it("masks IPv6 addresses in the canonical and ::-compressed forms (goal 120)", () => {
    // Canonical 8-group form.
    expect(maskPii("local 2001:0db8:85a3:0000:0000:8a2e:0370:7334 reachable").text)
      .toContain("[IPV6 MASKED]");
    // ::-compressed form (middle).
    expect(maskPii("server 2001:db8::8a2e:370:7334 listening").text)
      .toContain("[IPV6 MASKED]");
    // Loopback-style :: prefix.
    expect(maskPii("ping ::1 worked").text).toContain("[IPV6 MASKED]");
    // ::-compressed with trailing groups.
    expect(maskPii("uplink ::ffff:192.0.2.1 forwarded").text)
      .toContain("[IPV6 MASKED]");

    // IPv6 finding gets counted distinct from IPv4.
    const result = maskPii("v4 10.0.0.1 v6 2001:db8::1");
    const names = new Set(result.findings.map((f) => f.name));
    expect(names.has("ipv4")).toBe(true);
    expect(names.has("ipv6")).toBe(true);

    // No false-positive: plain English with a colon stays untouched.
    const plain = maskPii("Q3 budget due: review by Friday");
    expect(plain.text).toBe("Q3 budget due: review by Friday");
  });
});
