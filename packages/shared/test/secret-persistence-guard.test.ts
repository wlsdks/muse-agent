import { describe, expect, it } from "vitest";

import { SECRET_PATTERNS, findSecretsForGuard, guardSecretPersistence, assertNoSecretInPersistedFields } from "../src/index.js";

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

  // 주민등록번호 (Korean resident-registration number) — highly sensitive PII.
  // A plaintext RRN in an unencrypted note/task is the same harm the credential
  // guard prevents; the guard treated it as ordinary text before this.
  it("detects a Korean resident-registration number (national-id PII)", () => {
    const result = guardSecretPersistence("내 주민등록번호는 900101-1234567 이야, 노트에 저장해줘");
    expect(result.safe).toBe(false);
    if (!result.safe) {
      expect(result.kinds).toContain("national-id");
      expect(result.notice).toContain("주민등록번호");
    }
    expect(guardSecretPersistence("751225-2000000 기억해줘").safe).toBe(false);
  });

  it("does NOT over-block other hyphenated numbers (phone / business-reg / card / account)", () => {
    for (const benign of [
      "전화번호 010-1234-5678 저장해줘",
      "사업자등록번호 123-45-67890",
      "카드 1234-5678-9012-3456 메모",
      "계좌 110-234-567890 기억해",
      "회의는 2020-01-01 이야"
    ]) {
      expect(guardSecretPersistence(benign).safe).toBe(true);
    }
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

describe("assertNoSecretInPersistedFields — one call site for every multi-field persistence tool", () => {
  it("blocks when the label lands in one field and the value in another (title/notes split)", () => {
    const result = assertNoSecretInPersistedFields({ title: "reset router", notes: "비밀번호는 hunter2" });
    expect(result.safe).toBe(false);
    if (!result.safe) {
      expect(result.kinds).toContain("credential-label");
      expect(result.notice).toContain("암호화");
    }
  });

  it("blocks when label + value are combined across separate params (remember_fact key/value)", () => {
    expect(assertNoSecretInPersistedFields({ key: "wifi_password", value: "hunter2" }).safe).toBe(false);
  });

  it("is safe when every field is ordinary text", () => {
    const result = assertNoSecretInPersistedFields({ title: "우유 사기", notes: "6pm 전에" });
    expect(result.safe).toBe(true);
  });

  it("ignores undefined / empty fields without throwing", () => {
    expect(assertNoSecretInPersistedFields({ title: "회의실 4", notes: undefined, location: "" }).safe).toBe(true);
  });

  it("is safe on an empty field map", () => {
    expect(assertNoSecretInPersistedFields({}).safe).toBe(true);
  });

  it("still catches a vendor-shaped secret confined to a single field", () => {
    const result = assertNoSecretInPersistedFields({ title: "rotate key", notes: "sk-proj-abcdefghijklmnopqrstuvwxyz" });
    expect(result.safe).toBe(false);
  });

  it("ORDER-SENSITIVITY regression: a label-only field followed by a value-only field still blocks", () => {
    // The credential-label pattern is label-THEN-value; if a caller lists
    // fields in the wrong order (value field before the label field) this
    // silently stops matching — this pins the correct (label-first) order.
    expect(assertNoSecretInPersistedFields({ title: "비밀번호", notes: "hunter2" }).safe).toBe(false);
    // the reversed field order is the actual regression this guards against
    expect(assertNoSecretInPersistedFields({ notes: "hunter2", title: "비밀번호" }).safe).toBe(true);
  });
});
