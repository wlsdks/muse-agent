import { describe, expect, it } from "vitest";

import { SECRET_PATTERNS, findSecrets, findSecretsForGuard, guardSecretPersistence } from "../src/index.js";

describe("findSecrets / guardSecretPersistence — deterministic secret detection", () => {
  it("detects an explicit KO password label bound to a value (the live-probe repro)", () => {
    const result = guardSecretPersistence("내 비밀번호 hunter2를 노트에 저장해줘");
    expect(result.safe).toBe(false);
    if (!result.safe) {
      expect(result.kinds).toContain("credential-label");
      expect(result.notice).toContain("암호화");
    }
  });

  it("detects other KO labels (암호, 토큰) bound to a value", () => {
    expect(guardSecretPersistence("내 암호는 sunflower77").safe).toBe(false);
    expect(guardSecretPersistence("깃헙 토큰: gh_abc12345").safe).toBe(false);
  });

  it("detects an EN password label with an assignment", () => {
    expect(guardSecretPersistence("please save my password: hunter2 to a note").safe).toBe(false);
    expect(guardSecretPersistence("my password is qwerty12").safe).toBe(false);
  });

  it("detects vendor API-key shapes (sk-, ghp_, AKIA)", () => {
    expect(guardSecretPersistence("here's my key sk-proj-abcdefghijklmnopqrstuvwxyz").safe).toBe(false);
    expect(guardSecretPersistence("gh token ghp_abcdefghijklmnopqrstuvwxyzABCDEF").safe).toBe(false);
    expect(guardSecretPersistence("aws key AKIAIOSFODNN7EXAMPLE").safe).toBe(false);
  });

  it("detects a bearer-looking token", () => {
    expect(guardSecretPersistence("Authorization: Bearer abcDEF123456789012345").safe).toBe(false);
  });

  it("detects a BEGIN PRIVATE KEY block", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA PRIVATE KEY-----";
    const result = guardSecretPersistence(`save this:\n${pem}`);
    expect(result.safe).toBe(false);
    if (!result.safe) expect(result.kinds).toContain("private-key");
  });

  it("does NOT over-block a how-to question about passwords (no value present)", () => {
    expect(guardSecretPersistence("비밀번호 바꾸는 법 알려줘").safe).toBe(true);
    expect(guardSecretPersistence("how do I reset my password").safe).toBe(true);
  });

  it("does NOT over-block a policy note with no credential value", () => {
    expect(guardSecretPersistence("비밀번호 정책 노트에 적어줘: 12자 이상, 분기마다 변경").safe).toBe(true);
  });

  it("does NOT over-block ordinary content with no label at all", () => {
    expect(guardSecretPersistence("우유 사기 할 일에 추가해줘").safe).toBe(true);
    expect(guardSecretPersistence("Buy milk and call mom tomorrow at 6pm").safe).toBe(true);
  });

  it("is safe on empty / non-string input", () => {
    expect(guardSecretPersistence("").safe).toBe(true);
  });

  it("findSecrets exposes the raw matches (kind + value) for callers that need detail", () => {
    const matches = findSecretsForGuard("token: abc12345");
    expect(matches.some((m) => m.kind === "credential-label" && m.value.includes("abc12345"))).toBe(true);
  });
});

describe("credential-label over-block regression (adversarial gate FAIL #2/#3)", () => {
  it("does NOT block ordinary text where a keyword is followed by a plain English word", () => {
    for (const ordinary of [
      "the secret ingredient is patience",
      "Reset my password tomorrow morning",
      "Ask IT about api key provisioning process",
      "회의록: password rotation policy 논의함",
      "Write down the token exchange sequence diagram"
    ]) {
      expect(guardSecretPersistence(ordinary).safe).toBe(true);
    }
  });

  it("STILL blocks a real labeled credential (value has a digit/symbol or vendor shape)", () => {
    expect(guardSecretPersistence("내 비밀번호는 hunter2야").safe).toBe(false);
    expect(guardSecretPersistence("password: p@ssw0rd!").safe).toBe(false);
    expect(guardSecretPersistence("api key sk-abc123def456ghi").safe).toBe(false);
  });

  it("the fuzzy credential-label pattern is NOT in the shared masker list (redactor must stay high-precision)", () => {
    expect(SECRET_PATTERNS.some((p) => p.name === "credential-label")).toBe(false);
  });
});
