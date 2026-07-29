import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CLOUD_EGRESS_FIELD_CLASSES,
  CLOUD_PROVIDERS,
  diagnoseOpenAiCredential,
  cloudPrivacyRoutingGuidance,
  normalizeOpenAiDiagnosticTimeoutMs,
  OPENAI_DIAGNOSTIC_MAX_TIMEOUT_MS,
  planCloudEgressPreview,
  planCloudSetup,
  registerSetupCloudCommand,
  renderCloudEgressPreview,
  renderOpenAiDiagnosticReceipt,
  sanitizeBaseUrlForDisplay,
  type SetupCloudHelpers
} from "./commands-setup-cloud.js";
import type { ProgramIO } from "./program.js";

afterEach(() => {
  process.exitCode = undefined;
  vi.unstubAllGlobals();
});

describe("planCloudSetup — cloud BYO-key onboarding (muse setup cloud)", () => {
  it("unknown provider → undefined", () => {
    expect(planCloudSetup("llama-cloud", {})).toBeUndefined();
  });

  it("cloud allowed by default: only the API key is required when nothing is set", () => {
    const plan = planCloudSetup("gemini", {})!;
    expect(plan.defaultModel).toBe("gemini/gemini-2.0-flash");
    expect(plan.keyPresent).toBe(false);
    expect(plan.localOnlyDisabled).toBe(true);
    expect(plan.requiredExports).toEqual(["export GEMINI_API_KEY=<your-key>"]);
  });

  it("a --model override is namespaced under the provider id", () => {
    expect(planCloudSetup("anthropic", {}, "claude-opus-4-8")!.defaultModel).toBe("anthropic/claude-opus-4-8");
  });

  it("detects a present key (including the GOOGLE_API_KEY alias)", () => {
    const plan = planCloudSetup("gemini", { GOOGLE_API_KEY: "k" })!;
    expect(plan.keyPresent).toBe(true);
    expect(plan.requiredExports).toEqual([]);
    expect(planCloudSetup("gemini", { MUSE_MODEL_API_KEY: "generic-key" })!.keyPresent).toBe(true);
  });

  it("records the local-only conflict without treating it as ready", () => {
    const plan = planCloudSetup("openai", { OPENAI_API_KEY: "k", MUSE_LOCAL_ONLY: "true" })!;
    expect(plan.localOnlyDisabled).toBe(false);
    expect(plan.requiredExports).toEqual(["unset MUSE_LOCAL_ONLY"]);
    expect(planCloudSetup("openai", { MUSE_LOCAL_ONLY: "1" })!.localOnlyDisabled).toBe(false);
  });
});

describe("cloud egress preview", () => {
  it("projects every provider through its exact current default endpoint", () => {
    const expected = {
      anthropic: "https://api.anthropic.com/v1",
      gemini: "https://generativelanguage.googleapis.com/v1beta",
      openai: "https://api.openai.com/v1",
      openrouter: "https://openrouter.ai/api/v1"
    };
    for (const provider of CLOUD_PROVIDERS) {
      const preview = planCloudEgressPreview(planCloudSetup(provider.id, {})!, {});
      expect(preview.activeProviderId).toBe(provider.id);
      expect(preview.effectiveBaseUrl).toBe(expected[provider.id as keyof typeof expected]);
      expect(preview.locality).toBe("cloud");
    }
  });

  it("uses the authoritative runtime identity for a loopback base override", () => {
    const env = { MUSE_MODEL_BASE_URL: "http://127.0.0.1:8080/v1" };
    const preview = planCloudEgressPreview(planCloudSetup("gemini", env)!, env);
    expect(preview.activeProviderId).toBe("openai-compatible");
    expect(preview.customBaseUrl).toBe(true);
    expect(preview.effectiveBaseUrl).toBe("http://127.0.0.1:8080/v1");
    expect(preview.locality).toBe("local");
    expect(preview.selectedProvider.id).toBe("gemini");
  });

  it("classifies a remote base override as cloud", () => {
    const env = { MUSE_MODEL_BASE_URL: "https://models.example.test/v1" };
    const preview = planCloudEgressPreview(planCloudSetup("openai", env)!, env);
    expect(preview.activeProviderId).toBe("openai-compatible");
    expect(preview.customBaseUrl).toBe(true);
    expect(preview.locality).toBe("cloud");
  });

  it("treats an empty base override as unset, matching runtime resolution", () => {
    const env = { MUSE_MODEL_BASE_URL: "   " };
    const preview = planCloudEgressPreview(planCloudSetup("gemini", env)!, env);
    expect(preview.activeProviderId).toBe("gemini");
    expect(preview.customBaseUrl).toBe(false);
    expect(preview.effectiveBaseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
    expect(preview.locality).toBe("cloud");
  });

  it("redacts userinfo, query, and hash without echoing malformed input", () => {
    expect(sanitizeBaseUrlForDisplay("https://alice:p4ss@models.example.test/v1?api_key=query-secret#hash-secret"))
      .toBe("https://models.example.test/v1");
    expect(sanitizeBaseUrlForDisplay("not a url ?api_key=secret")).toBe("<invalid URL>");
  });

  it("lists the exact ModelRequest-aligned outbound field classes and disclaims default privacy tiers", () => {
    expect(CLOUD_EGRESS_FIELD_CLASSES).toEqual([
      "messages: system, user, assistant, and tool content",
      "conversation and personal context, when present",
      "tool schemas, calls, and results",
      "attachments (inline data or provider-fetchable URLs)",
      "generation and structured-output settings"
    ]);
    const preview = planCloudEgressPreview(planCloudSetup("gemini", {})!, {});
    const text = renderCloudEgressPreview(preview);
    for (const fieldClass of CLOUD_EGRESS_FIELD_CLASSES) expect(text).toContain(fieldClass);
    expect(text).toContain("not privacy-tiered");
  });
});

describe("cloudPrivacyRoutingGuidance — separate optional guidance", () => {
  it("explains context-free routing without changing the default-cloud disclaimer", () => {
    const text = cloudPrivacyRoutingGuidance("gemini/gemini-2.0-flash");
    expect(text).toContain("MUSE_PRIVACY_ROUTING");
    expect(text).toContain("MUSE_CLOUD_MODEL=gemini/gemini-2.0-flash");
    expect(text).toContain("context-free requests");
    expect(text).toContain("MUSE_LOCAL_ONLY");
  });
});

interface CommandHarness {
  readonly confirmEgress: ReturnType<typeof vi.fn>;
  readonly err: string[];
  readonly fetchImpl: ReturnType<typeof vi.fn>;
  readonly out: string[];
  readonly readConfigStore: ReturnType<typeof vi.fn>;
  readonly run: (args: readonly string[]) => Promise<number | undefined>;
  readonly writeConfigStore: ReturnType<typeof vi.fn>;
}

function commandHarness(options: {
  readonly confirm?: boolean;
  readonly diagnoseTimeoutMs?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly interactive?: boolean;
} = {}): CommandHarness {
  const out: string[] = [];
  const err: string[] = [];
  const fetchImpl = vi.fn();
  vi.stubGlobal("fetch", fetchImpl);
  const confirmEgress = vi.fn(async () => options.confirm ?? true);
  const readConfigStore = vi.fn(async () => ({ apiUrl: "http://127.0.0.1:3000" }));
  const writeConfigStore = vi.fn(async () => undefined);
  const io = {
    stderr: (message: string) => err.push(message),
    stdout: (message: string) => out.push(message)
  } as unknown as ProgramIO;
  const helpers: SetupCloudHelpers = {
    confirmEgress,
    diagnoseFetch: fetchImpl as unknown as typeof fetch,
    ...(options.diagnoseTimeoutMs === undefined ? {} : { diagnoseTimeoutMs: options.diagnoseTimeoutMs }),
    env: options.env ?? {},
    isInteractive: () => options.interactive ?? true,
    readConfigStore,
    writeConfigStore
  };
  const program = new Command("muse");
  program.exitOverride();
  program.command("setup").description("setup");
  registerSetupCloudCommand(program, io, helpers);
  return {
    confirmEgress,
    err,
    fetchImpl,
    out,
    readConfigStore,
    run: async (args) => {
      process.exitCode = undefined;
      await program.parseAsync(["node", "muse", "setup", "cloud", ...args], { from: "node" });
      return process.exitCode;
    },
    writeConfigStore
  };
}

describe("muse setup cloud — consent, read-only, and zero-request contract", () => {
  it("--check prints the preview but never prompts, reads, writes, or requests", async () => {
    const harness = commandHarness();
    await harness.run(["--provider", "gemini", "--check"]);
    expect(harness.out.join("")).toContain("Model data-flow / egress preview");
    expect(harness.out.join("")).toContain("--check mode: not writing config");
    expect(harness.out.join("")).not.toContain("✅ Configured");
    expect(harness.confirmEgress).not.toHaveBeenCalled();
    expect(harness.readConfigStore).not.toHaveBeenCalled();
    expect(harness.writeConfigStore).not.toHaveBeenCalled();
    expect(harness.fetchImpl).not.toHaveBeenCalled();
  });

  it("prints the full preview before interactive confirmation and applies only after acceptance", async () => {
    const harness = commandHarness({ confirm: true, env: { GEMINI_API_KEY: "key" } });
    harness.confirmEgress.mockImplementationOnce(async () => {
      expect(harness.out.join("")).toContain("Possible outbound field classes");
      return true;
    });
    expect(await harness.run(["--provider", "gemini"])).toBeUndefined();
    expect(harness.confirmEgress).toHaveBeenCalledTimes(1);
    expect(harness.readConfigStore).toHaveBeenCalledTimes(1);
    expect(harness.writeConfigStore).toHaveBeenCalledWith(
      expect.anything(),
      { apiUrl: "http://127.0.0.1:3000", defaultModel: "gemini/gemini-2.0-flash" }
    );
    expect(harness.fetchImpl).not.toHaveBeenCalled();
  });

  it("interactive cancellation is fail-closed: request 0 and config read/write 0", async () => {
    const harness = commandHarness({ confirm: false });
    expect(await harness.run(["--provider", "openai"])).toBe(1);
    expect(harness.out.join("")).toContain("Cloud setup cancelled");
    expect(harness.readConfigStore).not.toHaveBeenCalled();
    expect(harness.writeConfigStore).not.toHaveBeenCalled();
    expect(harness.fetchImpl).not.toHaveBeenCalled();
  });

  it("non-TTY without the explicit flag is fail-closed and does not prompt", async () => {
    const harness = commandHarness({ interactive: false });
    expect(await harness.run(["--provider", "anthropic"])).toBe(1);
    expect(harness.err.join("")).toContain("requires --accept-egress");
    expect(harness.confirmEgress).not.toHaveBeenCalled();
    expect(harness.readConfigStore).not.toHaveBeenCalled();
    expect(harness.writeConfigStore).not.toHaveBeenCalled();
    expect(harness.fetchImpl).not.toHaveBeenCalled();
  });

  it("--accept-egress is the narrow scripted consent and skips the prompt", async () => {
    const harness = commandHarness({ interactive: false });
    expect(await harness.run(["--provider", "openrouter", "--accept-egress"])).toBeUndefined();
    expect(harness.confirmEgress).not.toHaveBeenCalled();
    expect(harness.readConfigStore).toHaveBeenCalledTimes(1);
    expect(harness.writeConfigStore).toHaveBeenCalledTimes(1);
    expect(harness.fetchImpl).not.toHaveBeenCalled();
  });

  it("MUSE_LOCAL_ONLY=true blocks apply even with --accept-egress", async () => {
    const harness = commandHarness({
      env: { MUSE_LOCAL_ONLY: "true", OPENAI_API_KEY: "key" },
      interactive: false
    });
    expect(await harness.run(["--provider", "openai", "--accept-egress"])).toBe(1);
    expect(harness.out.join("")).toContain("Model data-flow / egress preview");
    expect(harness.out.join("")).not.toContain("✅ Configured");
    expect(harness.err.join("")).toContain("MUSE_LOCAL_ONLY=true conflicts");
    expect(harness.confirmEgress).not.toHaveBeenCalled();
    expect(harness.readConfigStore).not.toHaveBeenCalled();
    expect(harness.writeConfigStore).not.toHaveBeenCalled();
    expect(harness.fetchImpl).not.toHaveBeenCalled();
  });

  it("never prints API-key or URL credential markers and never performs a provider request", async () => {
    const harness = commandHarness({
      env: {
        GEMINI_API_KEY: "API_SECRET_MARKER",
        MUSE_MODEL_BASE_URL: "https://url-user:URL_SECRET_MARKER@models.example.test/v1?token=QUERY_SECRET_MARKER#HASH_SECRET_MARKER"
      },
      interactive: false
    });
    await harness.run(["--provider", "gemini", "--accept-egress"]);
    const allOutput = [...harness.out, ...harness.err].join("");
    expect(allOutput).toContain("https://models.example.test/v1");
    for (const marker of ["API_SECRET_MARKER", "URL_SECRET_MARKER", "QUERY_SECRET_MARKER", "HASH_SECRET_MARKER"]) {
      expect(allOutput).not.toContain(marker);
    }
    expect(harness.fetchImpl).not.toHaveBeenCalled();
    expect(harness.writeConfigStore).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["loopback", "http://127.0.0.1:8080/v1"],
    ["remote", "https://models.example.test/v1"]
  ])("gives active-provider-neutral credential guidance for a %s override", async (_label, baseUrl) => {
    const harness = commandHarness({
      env: { MUSE_MODEL_BASE_URL: baseUrl },
      interactive: false
    });
    await harness.run(["--provider", "gemini", "--check"]);
    const output = harness.out.join("");
    expect(output).toContain("MUSE_MODEL_API_KEY or OPENAI_API_KEY");
    expect(output).toContain("Credential validity is not checked");
    expect(output).not.toContain("export GEMINI_API_KEY");
    expect(output).not.toContain("✅ Ready to configure");
  });
});

describe("OpenAI credential diagnostic — bounded, body-blind receipt", () => {
  it.each([
    [200, "valid"],
    [299, "valid"],
    [401, "invalid"],
    [403, "invalid"],
    [408, "unreachable"],
    [429, "unreachable"],
    [500, "unreachable"],
    [503, "unreachable"],
    [400, "rejected"],
    [404, "rejected"],
    [422, "rejected"],
    [600, "rejected"],
    [302, "rejected"]
  ] as const)("classifies HTTP %i as %s without reading or returning the body", async (httpStatus, status) => {
    const fetchImpl = vi.fn(async () => ({
      body: "RAW_BODY_SECRET",
      status: httpStatus
    }) as unknown as Response);
    const receipt = await diagnoseOpenAiCredential({
      credential: "KEY_SECRET",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(receipt).toEqual({ httpStatus, requestCount: 1, status });
    expect(JSON.stringify(receipt)).not.toContain("RAW_BODY_SECRET");
    expect(JSON.stringify(receipt)).not.toContain("KEY_SECRET");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns missing-credential with request count zero", async () => {
    const fetchImpl = vi.fn();
    expect(await diagnoseOpenAiCredential({
      credential: "  ",
      fetchImpl: fetchImpl as unknown as typeof fetch
    })).toEqual({ requestCount: 0, status: "missing-credential" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps transport failure and hard timeout to unreachable with exactly one request", async () => {
    const transportFetch = vi.fn(async () => { throw new Error("RAW_TRANSPORT_SECRET"); });
    const transport = await diagnoseOpenAiCredential({
      credential: "key",
      fetchImpl: transportFetch as unknown as typeof fetch
    });
    expect(transport).toEqual({ requestCount: 1, status: "unreachable" });
    expect(transportFetch).toHaveBeenCalledTimes(1);

    const hangingFetch = vi.fn(() => new Promise<Response>(() => undefined));
    const timedOut = await diagnoseOpenAiCredential({
      credential: "key",
      fetchImpl: hangingFetch as unknown as typeof fetch,
      timeoutMs: 2
    });
    expect(timedOut).toEqual({ requestCount: 1, status: "unreachable" });
    expect(hangingFetch).toHaveBeenCalledTimes(1);
  });

  it("caps the diagnostic timeout at five seconds", () => {
    expect(normalizeOpenAiDiagnosticTimeoutMs(undefined)).toBe(OPENAI_DIAGNOSTIC_MAX_TIMEOUT_MS);
    expect(normalizeOpenAiDiagnosticTimeoutMs(99_000)).toBe(5_000);
    expect(normalizeOpenAiDiagnosticTimeoutMs(0)).toBe(1);
  });

  it("renders only fixed receipt text and the numeric status", () => {
    const rendered = renderOpenAiDiagnosticReceipt({ httpStatus: 401, requestCount: 1, status: "invalid" });
    expect(rendered).toBe("OpenAI diagnostic: credential rejected as invalid (HTTP 401).");
  });
});

describe("muse setup cloud --provider openai --diagnose", () => {
  it("missing credential prompts 0, requests 0, and writes 0", async () => {
    const harness = commandHarness();
    expect(await harness.run(["--provider", "openai", "--diagnose"])).toBe(1);
    expect(harness.out.join("")).toContain("missing credential; no request was sent");
    expect(harness.confirmEgress).not.toHaveBeenCalled();
    expect(harness.fetchImpl).not.toHaveBeenCalled();
    expect(harness.readConfigStore).not.toHaveBeenCalled();
    expect(harness.writeConfigStore).not.toHaveBeenCalled();
  });

  it("prints the preview before consent, sends one canonical body-free GET, and never writes config", async () => {
    const harness = commandHarness({ env: { OPENAI_API_KEY: "KEY_SECRET" } });
    harness.fetchImpl.mockResolvedValueOnce(new Response("RAW_BODY_SECRET", { status: 200 }));
    harness.confirmEgress.mockImplementationOnce(async () => {
      expect(harness.out.join("")).toContain("Model data-flow / egress preview");
      return true;
    });

    expect(await harness.run(["--provider", "openai", "--diagnose"])).toBeUndefined();
    expect(harness.fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = harness.fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/models");
    expect(init).toMatchObject({ method: "GET", redirect: "manual" });
    expect((init as RequestInit).body).toBeUndefined();
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer KEY_SECRET" });
    expect(harness.out.join("")).toContain("credential accepted (HTTP 200)");
    expect([...harness.out, ...harness.err].join("")).not.toContain("KEY_SECRET");
    expect([...harness.out, ...harness.err].join("")).not.toContain("RAW_BODY_SECRET");
    expect(harness.readConfigStore).not.toHaveBeenCalled();
    expect(harness.writeConfigStore).not.toHaveBeenCalled();
  });

  it("interactive cancel and non-TTY default both request 0/write 0", async () => {
    const cancelled = commandHarness({ confirm: false, env: { OPENAI_API_KEY: "key" } });
    expect(await cancelled.run(["--provider", "openai", "--diagnose"])).toBe(1);
    expect(cancelled.fetchImpl).not.toHaveBeenCalled();
    expect(cancelled.writeConfigStore).not.toHaveBeenCalled();

    const nonTty = commandHarness({ env: { OPENAI_API_KEY: "key" }, interactive: false });
    expect(await nonTty.run(["--provider", "openai", "--diagnose"])).toBe(1);
    expect(nonTty.confirmEgress).not.toHaveBeenCalled();
    expect(nonTty.fetchImpl).not.toHaveBeenCalled();
    expect(nonTty.writeConfigStore).not.toHaveBeenCalled();
  });

  it("local-only and --check conflict both request 0 even with explicit egress acceptance", async () => {
    const localOnly = commandHarness({
      env: { MUSE_LOCAL_ONLY: "true", OPENAI_API_KEY: "key" },
      interactive: false
    });
    expect(await localOnly.run(["--provider", "openai", "--diagnose", "--accept-egress"])).toBe(1);
    expect(localOnly.confirmEgress).not.toHaveBeenCalled();
    expect(localOnly.fetchImpl).not.toHaveBeenCalled();

    const checkConflict = commandHarness({
      env: { OPENAI_API_KEY: "key" },
      interactive: false
    });
    expect(await checkConflict.run(["--provider", "openai", "--diagnose", "--check", "--accept-egress"])).toBe(1);
    expect(checkConflict.confirmEgress).not.toHaveBeenCalled();
    expect(checkConflict.fetchImpl).not.toHaveBeenCalled();
    expect(checkConflict.writeConfigStore).not.toHaveBeenCalled();
  });

  it("--accept-egress allows the one request without prompting", async () => {
    const harness = commandHarness({
      env: { MUSE_MODEL_API_KEY: "generic-key" },
      interactive: false
    });
    harness.fetchImpl.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await harness.run(["--provider", "openai", "--diagnose", "--accept-egress"])).toBeUndefined();
    expect(harness.confirmEgress).not.toHaveBeenCalled();
    expect(harness.fetchImpl).toHaveBeenCalledTimes(1);
    expect(harness.writeConfigStore).not.toHaveBeenCalled();
  });

  it("refuses other providers and custom/provider overrides without a request", async () => {
    const other = commandHarness({ env: { GEMINI_API_KEY: "key" } });
    expect(await other.run(["--provider", "gemini", "--diagnose", "--accept-egress"])).toBe(1);
    expect(other.fetchImpl).not.toHaveBeenCalled();

    const custom = commandHarness({
      env: {
        MUSE_MODEL_BASE_URL: "https://models.example.test/v1",
        OPENAI_API_KEY: "key"
      }
    });
    expect(await custom.run(["--provider", "openai", "--diagnose", "--accept-egress"])).toBe(1);
    expect(custom.fetchImpl).not.toHaveBeenCalled();

    const providerOverride = commandHarness({
      env: {
        MUSE_MODEL_PROVIDER_ID: "anthropic",
        OPENAI_API_KEY: "key"
      }
    });
    expect(await providerOverride.run(["--provider", "openai", "--diagnose", "--accept-egress"])).toBe(1);
    expect(providerOverride.fetchImpl).not.toHaveBeenCalled();
  });
});
