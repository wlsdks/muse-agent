import { describe, expect, it } from "vitest";
import {
  allPiiPatterns,
  commonPiiPatterns,
  findPii,
  internationalPiiPatterns,
  krPiiPatterns,
  maskPii
} from "../src/index.js";

describe("PII patterns", () => {
  it("scans common patterns before the international group (credit-card ⊃ jp-my-number)", () => {
    expect(allPiiPatterns.map((pattern) => pattern.name)).toEqual([
      ...krPiiPatterns.map((pattern) => pattern.name),
      ...commonPiiPatterns.map((pattern) => pattern.name),
      ...internationalPiiPatterns.map((pattern) => pattern.name)
    ]);
  });

  it("masks a space-grouped credit card fully (jp-my-number must not claim its first 12 digits)", () => {
    const result = maskPii("my card is 1234 5678 9012 3456 ok");
    expect(result.text).toBe("my card is ****-****-****-**** ok");
    expect(result.text).not.toContain("3456");
    const names = result.findings.map((f) => f.name);
    expect(names).toContain("credit-card");
    expect(names).not.toContain("jp-my-number");

    // A genuine standalone 12-digit JP My Number is still masked
    // (the reorder fixed the overlap, it didn't disable the pattern).
    const jp = maskPii("my number 1234 5678 9012 please");
    expect(jp.text).toContain("**** **** ****");
    expect(jp.findings.map((f) => f.name)).toContain("jp-my-number");

    // The fail-close detection guard classifies it correctly too.
    expect(findPii("1234 5678 9012 3456").map((f) => f.name)).toContain("credit-card");
  });

  it("findPii detects zero-width / fullwidth / entity-split PII the raw regex misses", () => {
    const ZW = "\u200b";
    const fw = (s: string) =>
      [...s].map((c) => String.fromCodePoint(0xff10 + (c.charCodeAt(0) - 48))).join("");

    expect(findPii(`12${ZW}3-45-6789`).map((f) => f.name)).toContain("us-ssn");
    expect(findPii(`${fw("4111")} ${fw("4111")} ${fw("4111")} ${fw("4111")}`).map((f) => f.name))
      .toContain("credit-card");
    expect(findPii("123&#x200b;-45-6789").map((f) => f.name)).toContain("us-ssn");
    // Plain PII still detected (parity with maskPii detection).
    expect(findPii("my ssn is 123-45-6789").map((f) => f.name)).toContain("us-ssn");
    // No false positive on ordinary text.
    expect(findPii("Review the Q3 budget by Friday")).toEqual([]);
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

  it("detects each high-value PII class — incl. all the KOREAN ones (the user's most sensitive PII)", () => {
    const named = (text: string) => findPii(text).map((f) => f.name);
    // Korean PII: only us-ssn / credit-card / jp-my-number were positively asserted before.
    expect(named("주민번호 900101-1234567")).toContain("kr-national-id");
    expect(named("연락처 010-1234-5678")).toContain("kr-phone");
    expect(named("면허 11-22-334455-66")).toContain("kr-driver-license");
    expect(named("여권 M12345678")).toContain("kr-passport");
    // Email + IBAN classes were also unasserted.
    expect(named("메일 a.b@example.co.kr")).toContain("email");
    expect(named("IBAN DE89 3704 0044 0532 0130 00")).toContain("iban");
    // A plain Korean sentence trips none (no over-redaction).
    expect(named("그냥 평범한 문장입니다")).toEqual([]);
  });

  it("maskPii actually REDACTS a Korean national-id + email (not just detects)", () => {
    const result = maskPii("주민 900101-1234567 메일 a@b.com");
    expect(result.text).not.toContain("900101-1234567");
    expect(result.text).not.toContain("a@b.com");
    expect(result.findings.map((f) => f.name)).toEqual(expect.arrayContaining(["kr-national-id", "email"]));
  });
});
