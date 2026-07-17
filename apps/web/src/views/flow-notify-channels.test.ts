import { describe, expect, it } from "vitest";

import { deriveNotifyChannelOptions } from "./flow-notify-channels.js";

import type { MessagingSetupProvider, MessagingSetupResponse } from "../api/types.js";

function provider(overrides: Partial<MessagingSetupProvider>): MessagingSetupProvider {
  return {
    configured: true,
    displayName: "Telegram",
    docsUrl: "https://example.invalid",
    id: "telegram",
    registered: true,
    source: "file",
    pairedOwner: "12345",
    ...overrides
  };
}

function setup(providers: readonly MessagingSetupProvider[]): MessagingSetupResponse {
  return { providers };
}

describe("deriveNotifyChannelOptions", () => {
  it("returns [] for undefined or an empty provider list", () => {
    expect(deriveNotifyChannelOptions(undefined)).toEqual([]);
    expect(deriveNotifyChannelOptions(setup([]))).toEqual([]);
  });

  it("offers a configured + registered + paired provider as its resolved channel value", () => {
    const options = deriveNotifyChannelOptions(setup([provider({})]));
    expect(options).toEqual([
      { destination: "12345", displayName: "Telegram", providerId: "telegram", value: "telegram:12345" }
    ]);
  });

  it("excludes a provider that is not configured", () => {
    expect(deriveNotifyChannelOptions(setup([provider({ configured: false })]))).toEqual([]);
  });

  it("excludes a saved-but-not-live provider (registered:false — would fail at send)", () => {
    expect(deriveNotifyChannelOptions(setup([provider({ registered: false })]))).toEqual([]);
  });

  it("excludes a connected-but-unpaired provider (no owner to deliver to)", () => {
    expect(deriveNotifyChannelOptions(setup([provider({ pairedOwner: undefined })]))).toEqual([]);
    expect(deriveNotifyChannelOptions(setup([provider({ pairedOwner: "   " })]))).toEqual([]);
  });

  it("does not double the provider prefix when pairedOwner already carries it (Matrix)", () => {
    const options = deriveNotifyChannelOptions(
      setup([provider({ id: "matrix", displayName: "Matrix", pairedOwner: "matrix:@user:hs.test" })])
    );
    expect(options[0]?.value).toBe("matrix:@user:hs.test");
  });

  it("keeps only the deliverable providers when the list is mixed", () => {
    const options = deriveNotifyChannelOptions(
      setup([
        provider({ id: "telegram", displayName: "Telegram", pairedOwner: "111" }),
        provider({ id: "discord", displayName: "Discord", registered: false, pairedOwner: "222" }),
        provider({ id: "slack", displayName: "Slack", configured: false, pairedOwner: "333" }),
        provider({ id: "line", displayName: "LINE", pairedOwner: "444" })
      ])
    );
    expect(options.map((o) => o.value)).toEqual(["telegram:111", "line:444"]);
  });
});
