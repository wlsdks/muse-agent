import { describe, expect, it } from "vitest";
import { redactMigrationText } from "../src/index.js";

describe("redactMigrationText", () => {
  it("redacts common private migration material", () => {
    const result = redactMigrationText(
      [
        "Email: person@example.org",
        "URL: https://internal.example.org/path",
        "Token: sk-1234567890abcdefghijklmnop",
        "Path: /Users/example/private/project"
      ].join("\n")
    );

    expect(result.text).toContain("[redacted-email]");
    expect(result.text).toContain("[redacted-url]");
    expect(result.text).toContain("[redacted-token]");
    expect(result.text).toContain("[redacted-path]");
  });

  it("redacts non-http connection URIs with an inline password (the migration-log secret)", () => {
    const result = redactMigrationText(
      [
        "DB: postgres://muse:secretpw@db.internal:5432/muse_db",
        "Cache: redis://:authpw@cache:6379/0",
        "Plain: https://internal.example.org/path"
      ].join("\n")
    );

    expect(result.text).not.toContain("secretpw");
    expect(result.text).not.toContain("authpw");
    expect(result.text).toContain("[redacted-connection]");
    // The plain (credential-free) https URL still redacts via the
    // url rule — no regression in existing coverage.
    expect(result.text).toContain("[redacted-url]");
    expect(result.findings).toContainEqual({ count: 2, kind: "connection" });
  });

  it("redacts caller-provided names and company terms without reporting the original value", () => {
    const result = redactMigrationText("Jane Doe from Acme Corp approved the workflow.", {
      privateTerms: ["Jane Doe", "Acme Corp"]
    });

    expect(result.text).toBe(
      "[redacted-identifier] from [redacted-identifier] approved the workflow."
    );
    expect(result.findings).toContainEqual({ count: 2, kind: "private-term" });
  });

  it("leaves public provider names available for adapter documentation", () => {
    const result = redactMigrationText("OpenAI and Anthropic adapters are supported.");

    expect(result.text).toBe("OpenAI and Anthropic adapters are supported.");
    expect(result.findings).toEqual([]);
  });

  it("labels an http URI carrying inline credentials as a CONNECTION, not a url (rule order invariant)", () => {
    // Both the connection and url rules match `http://user:pass@host`. The
    // connection rule MUST run first so the credential is stripped and the
    // finding is reported as a connection — if the order flipped, the url rule
    // would consume it and mislabel a leaked secret as a harmless url.
    const result = redactMigrationText("conn: http://muse:secretpw@host.internal/db");

    expect(result.text).toBe("conn: [redacted-connection]");
    expect(result.text).not.toContain("secretpw");
    expect(result.text).not.toContain("[redacted-url]");
    expect(result.findings).toEqual([{ count: 1, kind: "connection" }]);
  });

  it("matches a regex-metacharacter private term LITERALLY (escapeRegExp), never as a pattern", () => {
    // "a.b" must redact the literal "a.b" and leave "axb" untouched — if the
    // term were compiled unescaped, "." would match any character and over-redact.
    const result = redactMigrationText("match a.b not axb", { privateTerms: ["a.b"] });

    expect(result.text).toBe("match [redacted-identifier] not axb");
    expect(result.findings).toEqual([{ count: 1, kind: "private-term" }]);

    const plus = redactMigrationText("C++ Corp shipped", { privateTerms: ["C++"] });
    expect(plus.text).toBe("[redacted-identifier] Corp shipped");
  });

  it("skips empty / whitespace-only private terms instead of redacting everything", () => {
    const result = redactMigrationText("hello world", { privateTerms: ["", "   "] });

    expect(result.text).toBe("hello world");
    expect(result.findings).toEqual([]);
  });

  it("matches a private term case-insensitively", () => {
    const result = redactMigrationText("Jane spoke", { privateTerms: ["jane"] });

    expect(result.text).toBe("[redacted-identifier] spoke");
    expect(result.findings).toEqual([{ count: 1, kind: "private-term" }]);
  });

  it("redacts GitHub (ghp_) and Slack (xox*) token shapes, not only OpenAI sk- keys", () => {
    expect(redactMigrationText("t: ghp_abcdefghijklmnop1234").text).toBe("t: [redacted-token]");
    expect(redactMigrationText("t: xoxb-abcdefghijklmnop-xyz").text).toBe("t: [redacted-token]");
  });
});
