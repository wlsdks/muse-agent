import { describe, expect, it } from "vitest";

import { createRemoteRequestInit } from "../src/index.js";

/**
 * The contract that was missing while the bug hid: a header supplied in
 * `config.headers` must reach the `requestInit` the SDK reuses for EVERY request
 * to a remote MCP server. Nothing wrote the `authToken`/`bearerToken` keys this
 * function used to read, so a preset's `Authorization: Bearer <token>` landed in
 * `config.headers` and was silently dropped — every authenticated remote server
 * 401'd, and no test noticed because the existing tests stopped at "the header
 * landed in config", never "the header reaches the request".
 */
const server = (config: Record<string, unknown>) =>
  ({ config, name: "s", transportType: "streamable" }) as never;

describe("createRemoteRequestInit — headers must reach the wire", () => {
  it("forwards a config.headers Authorization (the path presets and --header actually write)", () => {
    const init = createRemoteRequestInit(server({ headers: { Authorization: "Bearer ghp_xyz" } }));
    expect(init?.headers).toEqual({ Authorization: "Bearer ghp_xyz" });
  });

  it("forwards arbitrary custom headers, not just Authorization", () => {
    const init = createRemoteRequestInit(server({ headers: { "X-Api-Key": "k", "Notion-Version": "2022-06-28" } }));
    expect(init?.headers).toEqual({ "X-Api-Key": "k", "Notion-Version": "2022-06-28" });
  });

  it("still honours the authToken/bearerToken convenience as an Authorization header", () => {
    expect(createRemoteRequestInit(server({ authToken: "t1" }))?.headers).toEqual({ Authorization: "Bearer t1" });
    expect(createRemoteRequestInit(server({ bearerToken: "t2" }))?.headers).toEqual({ Authorization: "Bearer t2" });
  });

  it("merges config.headers with an explicit token — the token wins the Authorization slot, other headers survive", () => {
    const init = createRemoteRequestInit(
      server({ authToken: "explicit", headers: { Authorization: "Bearer stale", "X-Trace": "on" } })
    );
    expect(init?.headers).toEqual({ Authorization: "Bearer explicit", "X-Trace": "on" });
  });

  it("returns undefined when there is no auth and no header — a no-auth server is unchanged", () => {
    expect(createRemoteRequestInit(server({ url: "https://x/mcp" }))).toBeUndefined();
    expect(createRemoteRequestInit(server({ headers: {} }))).toBeUndefined();
  });
});
