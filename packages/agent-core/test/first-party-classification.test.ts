import { describe, expect, it } from "vitest";

import { isFirstPartyReadTool, WRITE_SINK_ARG_NAMES } from "../src/actuator-provenance-gate.js";

/**
 * Independent-review regression pins (2026-07-13). The first S3b cut classified
 * `knowledge_search` as first-party — but its corpus is wired with `emailSource`
 * (Gmail) and the feeds/browsing corpora, so a planted email or feed item read
 * back through it CANCELLED ITS OWN TAINT and persisted unflagged. A tool is
 * first-party only when every byte it can return is the user's own authored
 * content.
 */
describe("isFirstPartyReadTool — a MIXED-corpus reader is never first-party", () => {
  it("rejects knowledge_search (its corpus includes Gmail + feeds)", () => {
    expect(isFirstPartyReadTool("knowledge_search")).toBe(false);
  });

  it("rejects today_brief (same mixed-corpus hazard)", () => {
    expect(isFirstPartyReadTool("today_brief")).toBe(false);
  });

  it("rejects the third-party readers outright", () => {
    for (const name of ["muse.fetch", "feeds_search", "browsing_search", "muse.messaging.inbox", "email_recent", "browser_read", "web_fetch"]) {
      expect(isFirstPartyReadTool(name)).toBe(false);
    }
  });

  it("accepts the user's own stores", () => {
    for (const name of ["muse.notes.search", "muse.tasks.list", "muse.calendar.upcoming", "muse.reminders.list", "find_contact", "recall_facts"]) {
      expect(isFirstPartyReadTool(name)).toBe(true);
    }
  });

  it("an unknown/new tool is third-party by default (fail-closed)", () => {
    expect(isFirstPartyReadTool("some_new_tool")).toBe(false);
    expect(isFirstPartyReadTool("acme-mcp.read_page")).toBe(false);
  });
});

describe("WRITE_SINK_ARG_NAMES covers the contact fields add_contact persists", () => {
  it("includes every persisted free-text contact field", () => {
    for (const field of ["name", "phone", "email", "handle", "relationship", "birthday"]) {
      expect(WRITE_SINK_ARG_NAMES).toContain(field);
    }
  });

  it("includes the memory key alongside the value", () => {
    expect(WRITE_SINK_ARG_NAMES).toContain("key");
    expect(WRITE_SINK_ARG_NAMES).toContain("value");
  });
});
