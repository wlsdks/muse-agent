import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModelProvider, ModelRequest } from "@muse/model";

import {
  resolveSessionVisionModelRoute,
  resolveSessionVisionProvider,
  runVisionCommandAction
} from "./ask-vision-command.js";

const LOCAL_MODEL = "ollama/gemma4:12b";
const CLOUD_MODEL = "gemini/gemini-2.0-flash";

afterEach(() => {
  vi.unstubAllGlobals();
  process.exitCode = 0;
});

describe("vision auxiliary model egress", () => {
  it("blocks a cloud override in local-only mode before any probe or model call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const route = await resolveSessionVisionModelRoute(LOCAL_MODEL, {
      MUSE_AUX_VISION_MODEL: CLOUD_MODEL,
      MUSE_LOCAL_ONLY: "true"
    } as never);

    expect(route).toEqual({
      fallbackReason: "local-only-cloud-egress-blocked",
      model: LOCAL_MODEL
    });
    expect(fetchMock).not.toHaveBeenCalled();

    const cloudCalls: ModelRequest[] = [];
    const localCalls: ModelRequest[] = [];
    const provider = {
      generate: async (request: ModelRequest) => {
        (request.model.startsWith("gemini/") ? cloudCalls : localCalls).push(request);
        return { id: "vision", model: request.model, output: "{}" };
      },
      id: "ollama",
      listModels: async () => [],
      stream: async function* () {}
    } satisfies ModelProvider;

    await runVisionCommandAction({
      imageAttachments: [{ dataBase64: "aGVsbG8=", mimeType: "image/png" }],
      io: { stderr: () => undefined, stdout: () => undefined },
      model: route.model,
      modelProvider: provider,
      options: { extract: "merchant" },
      userKey: "owner"
    });

    expect(cloudCalls).toHaveLength(0);
    expect(localCalls).toHaveLength(1);
    expect(localCalls[0]?.model).toBe(LOCAL_MODEL);
  });

  it("keeps an explicit cloud vision model when local-only is off", async () => {
    const route = await resolveSessionVisionModelRoute(LOCAL_MODEL, {
      MUSE_AUX_VISION_MODEL: CLOUD_MODEL
    } as never);

    expect(route).toEqual({ model: CLOUD_MODEL });
  });

  it("constructs the provider bound to an overridden model instead of reusing the session endpoint", () => {
    const sessionProvider = providerStub("ollama");
    const cloudProvider = providerStub("gemini");
    const factory = vi.fn(() => cloudProvider);

    const selected = resolveSessionVisionProvider(
      LOCAL_MODEL,
      CLOUD_MODEL,
      sessionProvider,
      {} as never,
      factory
    );

    expect(selected).toBe(cloudProvider);
    expect(selected).not.toBe(sessionProvider);
    expect(factory).toHaveBeenCalledWith(CLOUD_MODEL, {});
  });

  it("fails closed when an overridden model has no constructible provider", () => {
    const sessionProvider = providerStub("ollama");
    const unavailableFactory = vi.fn(() => undefined);
    const throwingFactory = vi.fn(() => {
      throw new Error("missing provider configuration");
    });

    expect(resolveSessionVisionProvider(
      LOCAL_MODEL,
      CLOUD_MODEL,
      sessionProvider,
      {} as never,
      unavailableFactory
    )).toBeUndefined();
    expect(resolveSessionVisionProvider(
      LOCAL_MODEL,
      CLOUD_MODEL,
      sessionProvider,
      {} as never,
      throwingFactory
    )).toBeUndefined();
    expect(unavailableFactory).toHaveBeenCalledOnce();
    expect(throwingFactory).toHaveBeenCalledOnce();
  });
});

function providerStub(id: string): ModelProvider {
  return {
    generate: async (request) => ({ id: "response", model: request.model, output: "{}" }),
    id,
    listModels: async () => [],
    stream: async function* () {}
  };
}
