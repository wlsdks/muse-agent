import { describe, expect, it } from "vitest";

import {
  renderInboxSection,
  type InboxSnapshot
} from "../src/inbox-context.js";

describe("renderInboxSection", () => {
  it("returns undefined for empty / missing snapshot", () => {
    expect(renderInboxSection(undefined)).toBeUndefined();
    expect(renderInboxSection({ messages: [], totalByProvider: {} })).toBeUndefined();
  });

  it("groups by provider:source and renders messages", () => {
    const snapshot: InboxSnapshot = {
      messages: [
        {
          providerId: "slack",
          receivedAtIso: "2026-05-11T08:00:00.000Z",
          sender: "alice",
          source: "C1",
          text: "Hello there"
        },
        {
          providerId: "slack",
          receivedAtIso: "2026-05-11T08:05:00.000Z",
          sender: "bob",
          source: "C1",
          text: "Standup at 10?"
        },
        {
          providerId: "discord",
          receivedAtIso: "2026-05-11T08:10:00.000Z",
          source: "D-9",
          text: "PR merged"
        }
      ],
      totalByProvider: { discord: 1, slack: 2 }
    };
    const rendered = renderInboxSection(snapshot);
    expect(rendered).toContain("[Recent Messages]");
    expect(rendered).toContain("slack C1 (2)");
    expect(rendered).toContain("discord D-9 (1)");
    expect(rendered).toContain("Hello there");
    expect(rendered).toContain("PR merged");
  });

  it("truncates very long messages", () => {
    const snapshot: InboxSnapshot = {
      messages: [
        {
          providerId: "slack",
          receivedAtIso: "2026-05-11T08:00:00.000Z",
          source: "C1",
          text: "a".repeat(500)
        }
      ],
      totalByProvider: { slack: 1 }
    };
    const rendered = renderInboxSection(snapshot);
    expect(rendered).toMatch(/…/u);
  });
});
