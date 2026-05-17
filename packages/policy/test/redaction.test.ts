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
});
