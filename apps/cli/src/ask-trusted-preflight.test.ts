import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import { assertTrustedAskB1Preflight } from "./ask-trusted-preflight.js";

const calls = vi.hoisted(() => ({
  adHocGrounding: 0,
  autoImage: 0,
  composeInput: 0,
  context: 0,
  imageLoad: 0,
  runtimeAssembly: 0,
  toolWiring: 0,
  vision: 0
}));

vi.mock("./ask-input.js", () => ({
  composeAskInput: async () => {
    calls.composeInput += 1;
    return { ok: false };
  }
}));

vi.mock("./ask-image-attachments.js", () => ({
  collectAutoImageAttachments: async () => {
    calls.autoImage += 1;
    return [];
  },
  loadImageAttachment: async () => {
    calls.imageLoad += 1;
    return { error: "must not load", ok: false };
  }
}));

vi.mock("./ask-adhoc-grounding.js", () => ({
  applyAdHocGrounding: async () => {
    calls.adHocGrounding += 1;
  }
}));

vi.mock("./ask-context-setup.js", () => ({
  notesIndexPath: () => "",
  prepareAskContext: async () => {
    calls.context += 1;
    return { kind: "error" };
  }
}));

vi.mock("./ask-tool-wiring.js", () => ({
  buildAskToolWiring: async () => {
    calls.toolWiring += 1;
    return {};
  }
}));

vi.mock("./ask-vision-command.js", () => ({
  resolveSessionVisionModel: async () => "test-model",
  runVisionCommandAction: async () => {
    calls.vision += 1;
  }
}));

vi.mock("@muse/autoconfigure", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@muse/autoconfigure")>();
  return {
    ...actual,
    createMuseRuntimeAssembly: () => {
      calls.runtimeAssembly += 1;
      return {};
    }
  };
});

const { registerAskCommand } = await import("./commands-ask.js");

afterEach(() => {
  calls.adHocGrounding = 0;
  calls.autoImage = 0;
  calls.composeInput = 0;
  calls.context = 0;
  calls.imageLoad = 0;
  calls.runtimeAssembly = 0;
  calls.toolWiring = 0;
  calls.vision = 0;
  process.exitCode = 0;
});

describe("assertTrustedAskB1Preflight", () => {
  it("reports every forbidden option in fixed order and does not continue", () => {
    const stderr: string[] = [];

    expect(assertTrustedAskB1Preflight({
      actuators: true,
      apply: true,
      git: true,
      shell: true,
      url: "https://example.test"
    }, { stderr: (message) => { stderr.push(message); } })).toBe(false);

    expect(stderr.join("")).toBe([
      "muse ask: --actuators is unavailable in Muse's non-coding personal-read mode.",
      "muse ask: --apply is unavailable; Muse creates reviewable drafts only.",
      "muse ask: --url is unavailable; provide the material locally to analyze it.",
      "muse ask: --shell is unavailable; Muse does not inspect shell history.",
      "muse ask: --git is unavailable; Muse does not inspect repositories or git history."
    ].join("\n") + "\n");
    expect(process.exitCode).toBe(2);
  });
});

describe("muse ask trusted preflight", () => {
  const rejectedCases = [
    {
      args: ["--actuators", "summarize this"],
      message: "muse ask: --actuators is unavailable in Muse's non-coding personal-read mode."
    },
    {
      args: ["--apply", "--image", "/definitely-not-read.png", "summarize this"],
      message: "muse ask: --apply is unavailable; Muse creates reviewable drafts only."
    },
    {
      args: ["--apply", "--auto-image", "summarize this"],
      message: "muse ask: --apply is unavailable; Muse creates reviewable drafts only."
    },
    {
      args: ["--apply"],
      message: "muse ask: --apply is unavailable; Muse creates reviewable drafts only."
    },
    {
      args: ["--url", "https://example.test/report", "summarize this"],
      message: "muse ask: --url is unavailable; provide the material locally to analyze it."
    },
    {
      args: ["--shell", "summarize this"],
      message: "muse ask: --shell is unavailable; Muse does not inspect shell history."
    },
    {
      args: ["--git", "summarize this"],
      message: "muse ask: --git is unavailable; Muse does not inspect repositories or git history."
    }
  ] as const;

  for (const testCase of rejectedCases) {
    it(`${testCase.args.join(" ")} fails before every input, runtime, or tool-wiring path`, async () => {
      const stderr: string[] = [];
      const readPipedStdin = vi.fn(async () => "piped material that must stay unread");
      const program = new Command();
      registerAskCommand(program, {
        readPipedStdin,
        stderr: (message) => { stderr.push(message); },
        stdout: () => undefined
      });

      await program.parseAsync(["node", "muse", "ask", ...testCase.args]);

      expect(stderr.join("")).toContain(testCase.message);
      expect(process.exitCode).toBe(2);
      expect(readPipedStdin).not.toHaveBeenCalled();
      expect(calls.composeInput).toBe(0);
      expect(calls.imageLoad).toBe(0);
      expect(calls.autoImage).toBe(0);
      expect(calls.adHocGrounding).toBe(0);
      expect(calls.context).toBe(0);
      expect(calls.vision).toBe(0);
      expect(calls.runtimeAssembly).toBe(0);
      expect(calls.toolWiring).toBe(0);
    });
  }

  it("keeps help honest about the personal-read boundary", () => {
    const stdout: string[] = [];
    const program = new Command();
    registerAskCommand(program, { stderr: () => undefined, stdout: (message) => { stdout.push(message); } });
    const ask = program.commands.find((command) => command.name() === "ask");
    if (!ask) throw new Error("expected the ask command");
    ask.configureOutput({ writeErr: () => undefined, writeOut: (message) => { stdout.push(message); } });

    ask.outputHelp();

    const help = stdout.join("");
    expect(help).toMatch(/small local\s+personal-read set only/u);
    expect(help).toMatch(/Muse creates\s+reviewable drafts only/u);
    expect(help).toMatch(/does not inspect\s+shell history/u);
    expect(help).not.toContain("email_send, web_action, home_action");
  });
});
