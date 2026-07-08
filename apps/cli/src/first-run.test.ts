import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LOCAL_FIRST_DEFAULT_MODEL } from "@muse/autoconfigure";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CodexReadiness } from "./codex-cli.js";
import {
  CODEX_HONEST_COPY,
  FIRST_RUN_PICK_MESSAGE,
  FIRST_RUN_PROVIDER_OPTIONS,
  firstRunMarkerPath,
  firstRunSkipRequested,
  isFirstRunMarkerPresent,
  providerKeyPresent,
  runFirstRunWizard,
  shouldRunFirstRunSetup,
  writeFirstRunMarker,
  type FirstRunPrompts,
  type FirstRunWizardDeps
} from "./first-run.js";

const READY: FirstRunSignalsInput = {
  configuredModel: undefined,
  envModel: undefined,
  interactive: true,
  markerPresent: false,
  providerKeyPresent: false,
  skipRequested: false
};
type FirstRunSignalsInput = Parameters<typeof shouldRunFirstRunSetup>[0];

describe("shouldRunFirstRunSetup — the auto-launch guard (pure)", () => {
  it("fires only when interactive, unconfigured, keyless, unmarked, not skipped", () => {
    expect(shouldRunFirstRunSetup(READY)).toBe(true);
  });

  // Mutation-check: each suppressor MUST independently return false. If the
  // guard dropped any one of these clauses, one of these cases would flip.
  it.each([
    ["non-interactive (piped / non-TTY)", { ...READY, interactive: false }],
    ["skip requested (--no-setup / MUSE_SKIP_FIRST_RUN / test)", { ...READY, skipRequested: true }],
    ["marker already written (already ran once)", { ...READY, markerPresent: true }],
    ["a model already configured in config", { ...READY, configuredModel: "ollama/gemma4:12b" }],
    ["a model set via env (MUSE_MODEL)", { ...READY, envModel: "openai/gpt-4o-mini" }],
    ["a provider key already present", { ...READY, providerKeyPresent: true }]
  ])("does NOT fire: %s", (_label, signals) => {
    expect(shouldRunFirstRunSetup(signals)).toBe(false);
  });
});

describe("firstRunSkipRequested — never hijack a non-interactive / test run", () => {
  it("skips under VITEST / CI / NODE_ENV=test / explicit opt-out", () => {
    expect(firstRunSkipRequested({ VITEST: "true" })).toBe(true);
    expect(firstRunSkipRequested({ CI: "1" })).toBe(true);
    expect(firstRunSkipRequested({ NODE_ENV: "test" })).toBe(true);
    expect(firstRunSkipRequested({ MUSE_SKIP_FIRST_RUN: "yes" })).toBe(true);
    expect(firstRunSkipRequested({}, true)).toBe(true);
  });

  it("does not skip in a clean interactive-like env with no opt-out", () => {
    expect(firstRunSkipRequested({ PATH: "/usr/bin" })).toBe(false);
  });
});

describe("premium picker copy — bilingual KO · EN, Local first", () => {
  it("offers exactly local/cloud/codex with Local pre-selectable first", () => {
    expect(FIRST_RUN_PROVIDER_OPTIONS.map((o) => o.value)).toEqual(["local", "cloud", "codex"]);
  });

  it("each option is a titled line + a dim subtitle, both carrying Korean AND English", () => {
    for (const option of FIRST_RUN_PROVIDER_OPTIONS) {
      // A Hangul syllable somewhere in the label OR hint (KO present)…
      expect(/[가-힣]/u.test(`${option.label} ${option.hint}`)).toBe(true);
      // …and a Latin word (EN present) — the bilingual contract.
      expect(/[A-Za-z]/u.test(`${option.label} ${option.hint}`)).toBe(true);
      expect(option.hint.length).toBeGreaterThan(0);
    }
  });

  it("the pick prompt is step-framed (1 / 3) and bilingual; Codex copy names the unofficial route in both languages", () => {
    expect(FIRST_RUN_PICK_MESSAGE).toContain("1 / 3");
    expect(/[가-힣]/u.test(FIRST_RUN_PICK_MESSAGE)).toBe(true);
    expect(CODEX_HONEST_COPY).toContain("비공식");
    expect(CODEX_HONEST_COPY.toUpperCase()).toContain("UNOFFICIAL");
  });
});

describe("providerKeyPresent", () => {
  it("true when any known provider key is a non-empty string", () => {
    expect(providerKeyPresent({ ANTHROPIC_API_KEY: "sk-ant-x" })).toBe(true);
    expect(providerKeyPresent({ OPENAI_API_KEY: "   " })).toBe(false);
    expect(providerKeyPresent({})).toBe(false);
  });
});

describe("first-run marker", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "muse-firstrun-"));
  });
  afterEach(async () => {
    await rm(home, { force: true, recursive: true });
  });

  it("is absent before the wizard and present after writeFirstRunMarker", async () => {
    expect(isFirstRunMarkerPresent(home)).toBe(false);
    const file = await writeFirstRunMarker(home, "local");
    expect(file).toBe(firstRunMarkerPath(home));
    expect(isFirstRunMarkerPresent(home)).toBe(true);
    const raw = JSON.parse(await readFile(file, "utf8"));
    expect(raw.choice).toBe("local");
  });
});

interface StubState {
  written?: { readonly defaultModel?: string };
  codexConfigHome?: string;
  persistedKey?: { readonly providerId: string; readonly token: string };
  markerChoice?: string;
}

function makeDeps(
  selectSequence: readonly unknown[],
  overrides: {
    readonly home?: string;
    readonly codex?: CodexReadiness;
    readonly password?: string;
    readonly confirm?: boolean;
    readonly state: StubState;
    readonly selectThrows?: boolean;
  }
): FirstRunWizardDeps {
  const { state } = overrides;
  let selectIdx = 0;
  const prompts: FirstRunPrompts = {
    confirm: async () => overrides.confirm ?? false,
    isCancel: (v): v is symbol => typeof v === "symbol",
    note: () => undefined,
    password: async () => overrides.password ?? "",
    select: async () => {
      if (overrides.selectThrows) throw new Error("prompt exploded");
      return selectSequence[selectIdx++] as never;
    }
  };
  return {
    detectCodex: async () => overrides.codex ?? { authFile: "/x", cliOnPath: false, loggedIn: false, ready: false },
    env: {},
    home: overrides.home ?? "/home/u",
    persistCloudKey: async (providerId, token) => {
      state.persistedKey = { providerId, token };
      return "/home/u/.muse/models.json";
    },
    prompts,
    readConfig: async () => state.written ?? {},
    writeCodexConfig: async (home) => {
      state.codexConfigHome = home;
      return join(home, ".muse", "codex.json");
    },
    writeConfig: async (config) => {
      state.written = config;
    },
    writeMarker: async (_home, choice) => {
      state.markerChoice = choice;
      return "/home/u/.muse/first-run.json";
    }
  };
}

describe("runFirstRunWizard — picker → config", () => {
  it("Local writes the local default model and marks first-run done", async () => {
    const state: StubState = {};
    const result = await runFirstRunWizard(makeDeps(["local"], { state }));
    expect(result).toMatchObject({ choice: "local", markerWritten: true, wroteDefaultModel: LOCAL_FIRST_DEFAULT_MODEL });
    expect(state.written).toEqual({ defaultModel: LOCAL_FIRST_DEFAULT_MODEL });
    expect(state.markerChoice).toBe("local");
  });

  it("Cloud (API key) writes the provider's default model and persists the entered key", async () => {
    const state: StubState = {};
    const result = await runFirstRunWizard(makeDeps(["cloud", "openai"], { password: "sk-test-123", state }));
    expect(result).toMatchObject({ choice: "cloud", cloudKeyStored: true, wroteDefaultModel: "openai/gpt-4o-mini" });
    expect(state.written).toEqual({ defaultModel: "openai/gpt-4o-mini" });
    expect(state.persistedKey).toEqual({ providerId: "openai", token: "sk-test-123" });
  });

  it("Cloud with a blank key still writes the model but stores no key", async () => {
    const state: StubState = {};
    const result = await runFirstRunWizard(makeDeps(["cloud", "gemini"], { password: "", state }));
    expect(result).toMatchObject({ choice: "cloud", cloudKeyStored: false });
    expect(state.written).toEqual({ defaultModel: "gemini/gemini-2.0-flash" });
    expect(state.persistedKey).toBeUndefined();
  });

  it("Codex when NOT ready: shows guidance, writes NO codex config, marker still set", async () => {
    const state: StubState = {};
    const result = await runFirstRunWizard(makeDeps(["codex"], {
      codex: { authFile: "/x", cliOnPath: false, loggedIn: false, ready: false },
      state
    }));
    expect(result).toMatchObject({ choice: "codex", codexReady: false, markerWritten: true });
    expect(state.codexConfigHome).toBeUndefined();
    expect(state.markerChoice).toBe("codex");
  });

  it("Codex when ready + confirmed: writes the codex delegation config", async () => {
    const state: StubState = {};
    const result = await runFirstRunWizard(makeDeps(["codex"], {
      codex: { authFile: "/x", cliOnPath: true, cliPath: "/usr/bin/codex", loggedIn: true, ready: true },
      confirm: true,
      home: "/home/u",
      state
    }));
    expect(result).toMatchObject({ choice: "codex", codexReady: true });
    expect(state.codexConfigHome).toBe("/home/u");
  });

  it("Codex ready but user declines confirm: no codex config written", async () => {
    const state: StubState = {};
    await runFirstRunWizard(makeDeps(["codex"], {
      codex: { authFile: "/x", cliOnPath: true, loggedIn: true, ready: true },
      confirm: false,
      state
    }));
    expect(state.codexConfigHome).toBeUndefined();
  });

  it("cancelling the picker (symbol) is treated as skip and does not touch config", async () => {
    const state: StubState = {};
    const result = await runFirstRunWizard(makeDeps([Symbol("cancel")], { state }));
    expect(result.choice).toBe("skip");
    expect(state.written).toBeUndefined();
    expect(state.markerChoice).toBe("skip");
  });

  it("is fail-soft: a prompt that throws returns skip (never bricks muse) and marks done", async () => {
    const state: StubState = {};
    const result = await runFirstRunWizard(makeDeps([], { selectThrows: true, state }));
    expect(result).toEqual({ choice: "skip", markerWritten: true });
    expect(state.markerChoice).toBe("error");
    expect(state.written).toBeUndefined();
  });
});

interface ValueState {
  markerChoice?: string;
  writtenModel?: string;
  dataFlags?: Record<string, boolean>;
  dataConnectCalls: number;
  defaultsCalls: number;
  outros: string[];
  celebrated: boolean;
}

function makeValueDeps(overrides: {
  readonly select: readonly unknown[];
  readonly state: ValueState;
  readonly multiselect?: readonly string[] | symbol;
  readonly dataResult?: { readonly contactsImported?: number; readonly browsingSynced?: number };
  readonly dataThrows?: boolean;
  readonly skillsScaffolded?: number;
  readonly identityName?: string;
  readonly withDataDeps?: boolean;
}): FirstRunWizardDeps {
  const { state } = overrides;
  let selectIdx = 0;
  const wire = overrides.withDataDeps ?? true;
  const prompts: FirstRunPrompts = {
    confirm: async () => true,
    isCancel: (v): v is symbol => typeof v === "symbol",
    multiselect: wire ? (async () => overrides.multiselect ?? []) as FirstRunPrompts["multiselect"] : undefined,
    note: () => undefined,
    outro: (message) => state.outros.push(message),
    password: async () => "",
    select: async () => overrides.select[selectIdx++] as never
  };
  return {
    applyDefaults: wire
      ? async () => {
          state.defaultsCalls += 1;
          return { skillsScaffolded: overrides.skillsScaffolded ?? 0 };
        }
      : undefined,
    celebrate: () => {
      state.celebrated = true;
    },
    env: {},
    home: "/home/u",
    prompts,
    readConfig: async () => ({}),
    ...(overrides.identityName ? { readIdentity: async () => ({ name: overrides.identityName }) } : {}),
    runDataConnect: wire
      ? async (flags) => {
          state.dataConnectCalls += 1;
          state.dataFlags = flags as unknown as Record<string, boolean>;
          if (overrides.dataThrows) throw new Error("ingest exploded");
          const dr = overrides.dataResult;
          return {
            alreadyEnabled: [],
            declined: [],
            failed: [],
            stagedSwitches: [],
            ...(dr?.contactsImported !== undefined
              ? { contacts: { imported: dr.contactsImported, skipped: 0, total: dr.contactsImported, updated: 0 } }
              : {}),
            ...(dr?.browsingSynced !== undefined ? { browsing: { synced: dr.browsingSynced, total: dr.browsingSynced } } : {})
          };
        }
      : undefined,
    writeConfig: async (config) => {
      state.writtenModel = config.defaultModel;
    },
    writeMarker: async (_home, choice) => {
      state.markerChoice = choice;
      return "/home/u/.muse/first-run.json";
    }
  };
}

function freshValueState(): ValueState {
  return { celebrated: false, dataConnectCalls: 0, defaultsCalls: 0, outros: [] };
}

describe("runFirstRunWizard — the install→first-value tail (data-connect · defaults · first-value)", () => {
  it("routes the multi-select picks through setup-data flag mode and grounds the first-value line on the result", async () => {
    const state = freshValueState();
    const result = await runFirstRunWizard(makeValueDeps({
      dataResult: { browsingSynced: 9, contactsImported: 5 },
      multiselect: ["contacts", "browsing"],
      select: ["local"],
      state
    }));
    expect(state.dataConnectCalls).toBe(1);
    expect(state.dataFlags).toEqual({ browsing: true, contacts: true, notesMirror: false, remindersMirror: false });
    expect(result.dataConnected).toEqual(["contacts", "browsing"]);
    expect(result.firstValueGrounded).toBe(true);
    // The success line asserts only the real connected count.
    expect(state.outros.at(-1)).toContain("5");
    expect(state.celebrated).toBe(true);
  });

  it("skipping the data step (empty multi-select) connects nothing and shows a content-free welcome", async () => {
    const state = freshValueState();
    const result = await runFirstRunWizard(makeValueDeps({ multiselect: [], select: ["local"], state }));
    expect(state.dataConnectCalls).toBe(0);
    expect(result.dataConnected).toEqual([]);
    expect(result.firstValueGrounded).toBe(false);
    expect(/\d/u.test(state.outros.at(-1) ?? "")).toBe(false);
  });

  it("cancelling the data step (symbol) also connects nothing", async () => {
    const state = freshValueState();
    const result = await runFirstRunWizard(makeValueDeps({ multiselect: Symbol("cancel"), select: ["local"], state }));
    expect(state.dataConnectCalls).toBe(0);
    expect(result.dataConnected).toEqual([]);
  });

  it("propagates the smart-defaults scaffold count into the result", async () => {
    const state = freshValueState();
    const result = await runFirstRunWizard(makeValueDeps({ multiselect: [], select: ["local"], skillsScaffolded: 2, state }));
    expect(state.defaultsCalls).toBe(1);
    expect(result.skillsScaffolded).toBe(2);
  });

  it("greets by a known name when there is no connected source yet", async () => {
    const state = freshValueState();
    const result = await runFirstRunWizard(makeValueDeps({ identityName: "Jinan", multiselect: [], select: ["local"], state }));
    expect(result.firstValueGrounded).toBe(true);
    expect(state.outros.at(-1)).toContain("Jinan");
  });

  it("is fail-soft: a throwing data-connect never bricks the wizard (still marks + finishes local)", async () => {
    const state = freshValueState();
    const result = await runFirstRunWizard(makeValueDeps({
      dataThrows: true,
      multiselect: ["contacts"],
      select: ["local"],
      state
    }));
    expect(result).toMatchObject({ choice: "local", markerWritten: true, wroteDefaultModel: LOCAL_FIRST_DEFAULT_MODEL });
    expect(state.markerChoice).toBe("local");
    // The tail swallowed the error and still reached the success screen.
    expect(state.celebrated).toBe(true);
  });

  it("without the value-tail deps wired (tests / non-interactive), the wizard behaves as before", async () => {
    const state = freshValueState();
    const result = await runFirstRunWizard(makeValueDeps({ select: ["local"], state, withDataDeps: false }));
    expect(result.dataConnected).toEqual([]);
    expect(result.skillsScaffolded).toBe(0);
    expect(state.dataConnectCalls).toBe(0);
  });
});

describe("integration guard — first-run stays OFF under vitest", () => {
  it("the real process env (VITEST set by the runner) suppresses auto-launch", () => {
    // This test runs under vitest, so firstRunSkipRequested(process.env) must
    // be true — proving the suite can never trip the wizard for real.
    expect(firstRunSkipRequested(process.env)).toBe(true);
  });
});
