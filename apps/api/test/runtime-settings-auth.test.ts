import { describe, expect, it } from "vitest";

import { buildServer } from "../src/server.js";
import { createAuthService } from "./helpers/test-auth.js";

describe("authenticated runtime settings", () => {
  it("records the authenticated actor instead of a client-supplied updatedBy value", async () => {
    const authService = createAuthService();
    const account = authService.register({ email: "settings_actor", name: "Settings Actor", password: "password-1" });
    const server = buildServer({ authService, logger: false, requireAuth: true });

    const saved = await server.inject({
      headers: { authorization: `Bearer ${account.token}` },
      method: "PUT",
      payload: { type: "string", updatedBy: "spoofed-user", value: "provider/model" },
      url: "/settings/model.default"
    });
    const fetched = await server.inject({
      headers: { authorization: `Bearer ${account.token}` },
      method: "GET",
      url: "/settings/model.default"
    });

    expect(saved.statusCode).toBe(200);
    expect(fetched.json()).toMatchObject({ key: "model.default", updatedBy: account.user.id });

    await server.close();
  });
});
