import { describe, expect, it } from "vitest";

import {
  OUTBOUND_SEND_SINK_ARG_NAMES,
  OUTBOUND_SEND_TOOL_NAMES,
  resolveThirdPartySendRoute
} from "../src/actuator-provenance-gate.js";

describe("third-party send route classification", () => {
  it("covers every shipped irreversible outbound send and its sink arguments", () => {
    expect(OUTBOUND_SEND_TOOL_NAMES).toEqual([
      "email_send",
      "email_reply",
      "email_forward",
      "web_action",
      "mac_message_send",
      "muse.messaging.send",
      "objective.act"
    ]);
    expect(OUTBOUND_SEND_SINK_ARG_NAMES).toEqual(expect.arrayContaining(["destination", "recipientName"]));
  });

  it("binds only routes that are exact before actuator execution", () => {
    expect(resolveThirdPartySendRoute("web_action", { url: "https://example.com/book" })).toEqual({
      channel: "web",
      kind: "bound",
      recipient: "https://example.com/book"
    });
    expect(resolveThirdPartySendRoute("muse.messaging.send", {
      destination: "C123",
      providerId: "slack"
    })).toEqual({ channel: "slack", kind: "bound", recipient: "C123" });
    expect(resolveThirdPartySendRoute("mac_message_send", { to: "+14155551212" })).toEqual({
      channel: "macos-messages",
      kind: "bound",
      recipient: "+14155551212"
    });
  });

  it.each([
    ["email_send", { to: "Bob" }],
    ["email_reply", { id: "mail-1" }],
    ["email_forward", { id: "mail-1", to: "Bob" }],
    ["web_action", { summary: "Book" }],
    ["muse.messaging.send", { destination: "C123" }],
    ["mac_message_send", { recipientName: "Jane" }],
    ["objective.act", { recipient: "someone" }]
  ])("fails closed when %s still needs route resolution", (tool, args) => {
    expect(resolveThirdPartySendRoute(tool, args)).toMatchObject({ kind: "unbound" });
  });

  it("leaves local mutations outside the third-party contract", () => {
    expect(resolveThirdPartySendRoute("muse.tasks.add", { title: "Call dentist" })).toEqual({
      kind: "not-third-party"
    });
  });
});
