import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CLOUD_EGRESS_FIELD_CLASSES,
  CLOUD_PROVIDERS,
  cloudPrivacyRoutingGuidance,
  planCloudEgressPreview,
  planCloudSetup,
  registerSetupCloudCommand,
  renderCloudEgressPreview,
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
