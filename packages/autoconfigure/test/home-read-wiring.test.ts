import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createApiServerOptions, createMuseRuntimeAssembly } from "../src/index.js";

interface HomeCredentialTrapCounts {
  get: number;
  getOwnPropertyDescriptor: number;
  has: number;
  ownKeys: number;
}

function poisonHomeEnvironment(input: { readonly url?: string; readonly localOnly: string }): {
  readonly env: NodeJS.ProcessEnv;
  readonly traps: HomeCredentialTrapCounts;
} {
  const root = mkdtempSync(join(tmpdir(), "muse-ha-env-"));
  const source: Record<string, string | undefined> = {
    HOME: root,
    MUSE_HOMEASSISTANT_TOKEN: "must-not-read",
    MUSE_HOMEASSISTANT_URL: input.url,
    MUSE_LOCAL_ONLY: input.localOnly,
    MUSE_MODEL_KEYS_FILE: join(root, "models.json")
  };
  // Exercise the model-overlay path without handing it a real HA token.
  writeFileSync(source.MUSE_MODEL_KEYS_FILE!, JSON.stringify({ providers: { ollama: { suggestedModel: "ollama/test", token: "http://127.0.0.1:11434/v1" } } }));
  const traps: HomeCredentialTrapCounts = { get: 0, getOwnPropertyDescriptor: 0, has: 0, ownKeys: 0 };
  return {
    env: new Proxy(source, {
      get(target, property, receiver) {
        if (property === "MUSE_HOMEASSISTANT_TOKEN") {
          traps.get += 1;
          throw new Error("HA token must not be read for a blocked or blank endpoint");
        }
        return Reflect.get(target, property, receiver);
      },
      getOwnPropertyDescriptor(target, property) {
        if (property === "MUSE_HOMEASSISTANT_TOKEN") {
          traps.getOwnPropertyDescriptor += 1;
          throw new Error("HA token descriptor must not be read");
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      has(target, property) {
        if (property === "MUSE_HOMEASSISTANT_TOKEN") {
          traps.has += 1;
          throw new Error("HA token presence must not be checked");
        }
        return Reflect.has(target, property);
      },
      ownKeys(target) {
        traps.ownKeys += 1;
        return Reflect.ownKeys(target);
      }
    }) as NodeJS.ProcessEnv,
    traps
  };
}

describe("createMuseRuntimeAssembly — smart-home READ tools reachability gating", () => {
  it("exposes home_state + home_entities when Home Assistant creds are set", () => {
    const assembly = createMuseRuntimeAssembly({
      env: { MUSE_HOMEASSISTANT_TOKEN: "ha-tok", MUSE_HOMEASSISTANT_URL: "http://ha.local:8123" }
    });
    expect(assembly.toolRegistry.get("home_state")).toBeDefined();
    expect(assembly.toolRegistry.get("home_entities")).toBeDefined();
    // Read tools — ungated perception (not the execute-risk actuator set).
    expect(assembly.toolRegistry.get("home_state")!.definition.risk).toBe("read");
    expect(assembly.toolRegistry.get("home_entities")!.definition.risk).toBe("read");
  });

  it("does NOT expose the home read tools without HA creds (opt-in)", () => {
    expect(createMuseRuntimeAssembly({ env: {} }).toolRegistry.get("home_state")).toBeUndefined();
    // URL without token is incomplete → still off.
    const partial = createMuseRuntimeAssembly({ env: { MUSE_HOMEASSISTANT_URL: "http://ha.local:8123" } });
    expect(partial.toolRegistry.get("home_entities")).toBeUndefined();
  });

  it("hides remote HA tools under injected local-only before any token reflection, even through a nonempty models.json overlay", () => {
    const { env, traps } = poisonHomeEnvironment({ localOnly: "true", url: "http://ha.local:8123" });
    const assembly = createMuseRuntimeAssembly({ env });
    expect(assembly.toolRegistry.get("home_state")).toBeUndefined();
    expect(assembly.toolRegistry.get("home_entities")).toBeUndefined();
    expect(traps).toEqual({ get: 0, getOwnPropertyDescriptor: 0, has: 0, ownKeys: 0 });
  });

  it("treats absent and whitespace-only HA URLs as unconfigured before any token reflection", () => {
    for (const url of [undefined, "   "]) {
      const { env, traps } = poisonHomeEnvironment({ localOnly: "true", url });
      const assembly = createMuseRuntimeAssembly({ env });
      expect(assembly.toolRegistry.get("home_state"), String(url)).toBeUndefined();
      expect(traps, String(url)).toEqual({ get: 0, getOwnPropertyDescriptor: 0, has: 0, ownKeys: 0 });
    }
  });

  describe.sequential("ambient local-only floor", () => {
    const previous = process.env.MUSE_LOCAL_ONLY;

    afterEach(() => {
      if (previous === undefined) delete process.env.MUSE_LOCAL_ONLY;
      else process.env.MUSE_LOCAL_ONLY = previous;
    });

    it("does not let a frozen false reopen remote Home Assistant in an actually strict process", () => {
      process.env.MUSE_LOCAL_ONLY = "true";
      const { env, traps } = poisonHomeEnvironment({ localOnly: "false", url: "http://ha.local:8123" });
      const assembly = createMuseRuntimeAssembly({ env, localOnlyOverride: false });
      expect(assembly.toolRegistry.get("home_state")).toBeUndefined();
      expect(traps).toEqual({ get: 0, getOwnPropertyDescriptor: 0, has: 0, ownKeys: 0 });
    });

    it("keeps the same token boundary through createApiServerOptions", () => {
      process.env.MUSE_LOCAL_ONLY = "true";
      const { env, traps } = poisonHomeEnvironment({ localOnly: "false", url: "http://ha.local:8123" });
      const options = createApiServerOptions({ env, localOnlyOverride: false });
      const names = options.toolCatalogProvider!().map((tool) => tool.name);
      expect(names).not.toContain("home_state");
      expect(names).not.toContain("home_entities");
      expect(traps).toEqual({ get: 0, getOwnPropertyDescriptor: 0, has: 0, ownKeys: 0 });
    });

    it("derives the ambient strict floor before direct runtime model-key merging for remote, absent, and blank HA URLs", () => {
      process.env.MUSE_LOCAL_ONLY = "true";
      for (const url of ["http://ha.local:8123", undefined, "   "]) {
        const { env, traps } = poisonHomeEnvironment({ localOnly: "false", url });
        const assembly = createMuseRuntimeAssembly({ env });
        expect(assembly.toolRegistry.get("home_state"), String(url)).toBeUndefined();
        expect(assembly.toolRegistry.get("home_entities"), String(url)).toBeUndefined();
        expect(traps, String(url)).toEqual({ get: 0, getOwnPropertyDescriptor: 0, has: 0, ownKeys: 0 });
      }
    });

    it("derives the ambient strict floor before direct API-options model-key merging for remote, absent, and blank HA URLs", () => {
      process.env.MUSE_LOCAL_ONLY = "true";
      for (const url of ["http://ha.local:8123", undefined, "   "]) {
        const { env, traps } = poisonHomeEnvironment({ localOnly: "false", url });
        const options = createApiServerOptions({ env });
        expect(options.integrationEnv.localOnly, String(url)).toBe(true);
        expect(options.localOnly, String(url)).toBe(true);
        const names = options.toolCatalogProvider!().map((tool) => tool.name);
        expect(names, String(url)).not.toContain("home_state");
        expect(names, String(url)).not.toContain("home_entities");
        expect(traps, String(url)).toEqual({ get: 0, getOwnPropertyDescriptor: 0, has: 0, ownKeys: 0 });
      }
    });

    it("keeps a canonical loopback endpoint available after the ambient strict model overlay", () => {
      process.env.MUSE_LOCAL_ONLY = "true";
      const assembly = createMuseRuntimeAssembly({
        env: {
          MUSE_HOMEASSISTANT_TOKEN: "ha-tok",
          MUSE_HOMEASSISTANT_URL: "http://localhost:8123/",
          MUSE_LOCAL_ONLY: "false"
        }
      });
      expect(assembly.toolRegistry.get("home_state")).toBeDefined();
      expect(assembly.toolRegistry.get("home_entities")).toBeDefined();
    });

    it("keeps source-true plus an explicit false override normal only when the actual process is normal", () => {
      process.env.MUSE_LOCAL_ONLY = "false";
      const assembly = createMuseRuntimeAssembly({
        env: {
          MUSE_HOMEASSISTANT_TOKEN: "ha-tok",
          MUSE_HOMEASSISTANT_URL: "http://ha.local:8123",
          MUSE_LOCAL_ONLY: "true"
        },
        localOnlyOverride: false
      });
      expect(assembly.toolRegistry.get("home_state")).toBeDefined();
      expect(assembly.toolRegistry.get("home_entities")).toBeDefined();
    });
  });

  it("keeps a canonical loopback Home Assistant endpoint available under local-only", () => {
    const assembly = createMuseRuntimeAssembly({
      env: {
        MUSE_HOMEASSISTANT_TOKEN: "ha-tok",
        MUSE_HOMEASSISTANT_URL: "http://localhost:8123/",
        MUSE_LOCAL_ONLY: "true"
      }
    });
    expect(assembly.toolRegistry.get("home_state")).toBeDefined();
    expect(assembly.toolRegistry.get("home_entities")).toBeDefined();
  });
});
