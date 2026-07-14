import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { computeOnboarding, registerOnboardCommand, type OnboardingState } from "./commands-onboard.js";
import type { ProgramIO } from "./program.js";

const base: OnboardingState = {
  chatModel: "qwen3:8b",
  embedModel: "nomic-embed-text",
  indexBuilt: false,
  installedModels: [],
  noteFileCount: 0,
  notesDir: "/home/u/.muse/notes",
  ollamaReachable: false
};

const next = (s: OnboardingState) => computeOnboarding(s);

describe("computeOnboarding — the single next step to the first cited answer", () => {
  it("Ollama down → next is `ollama serve`, not ready", () => {
    const r = next(base);
    expect(r.ready).toBe(false);
    expect(r.nextCommand).toBe("ollama serve");
    expect(r.steps[0]).toMatchObject({ id: "ollama", status: "action" });
  });

  it("Ollama up but no models → next pulls the chat model first (dependency order)", () => {
    const r = next({ ...base, ollamaReachable: true });
    expect(r.nextCommand).toBe("ollama pull qwen3:8b");
  });

  it("models present (base/tag match) but empty corpus → next is `muse ingest`", () => {
    const r = next({ ...base, installedModels: ["qwen3:8b", "nomic-embed-text:latest"], ollamaReachable: true });
    expect(r.steps.find((s) => s.id === "chat-model")?.status).toBe("ok");
    expect(r.steps.find((s) => s.id === "embed-model")?.status).toBe("ok"); // :latest tag matches base
    expect(r.nextCommand).toContain("muse ingest");
  });

  it("corpus present but no index → next is `muse notes reindex`", () => {
    const r = next({ ...base, installedModels: ["qwen3:8b", "nomic-embed-text"], noteFileCount: 12, ollamaReachable: true });
    expect(r.nextCommand).toBe("muse notes reindex");
  });

  it("everything ready → ready=true, next is the ask example", () => {
    const r = next({ ...base, indexBuilt: true, installedModels: ["qwen3:8b", "nomic-embed-text"], noteFileCount: 12, ollamaReachable: true });
    expect(r.ready).toBe(true);
    expect(r.nextCommand).toContain("muse ask --notes-only");
    expect(r.steps.every((s) => s.status === "ok")).toBe(true);
  });

  it("honours a custom chat model in the action + label", () => {
    const r = next({ ...base, chatModel: "llama3.2:3b", ollamaReachable: true });
    expect(r.nextCommand).toBe("ollama pull llama3.2:3b");
    expect(r.steps.find((s) => s.id === "chat-model")?.title).toContain("llama3.2:3b");
  });

  it("empty personal sensors (no contacts, no browsing) → connect-data hint points at `muse setup data`", () => {
    const r = next({ ...base, browsingVisitCount: 0, contactsCount: 0 });
    expect(r.dataHint?.command).toBe("muse setup data");
  });

  it("any personal data present → no connect-data hint (they've already started)", () => {
    expect(next({ ...base, contactsCount: 12 }).dataHint).toBeUndefined();
    expect(next({ ...base, browsingVisitCount: 5 }).dataHint).toBeUndefined();
  });

  it("does not gate readiness on personal data — a ready notes setup stays ready with empty sensors", () => {
    const r = next({ ...base, browsingVisitCount: 0, contactsCount: 0, indexBuilt: true, installedModels: ["qwen3:8b", "nomic-embed-text"], noteFileCount: 12, ollamaReachable: true });
    expect(r.ready).toBe(true);
    expect(r.dataHint?.command).toBe("muse setup data");
  });
});

describe("muse onboard — closing hints (R2-3)", () => {
  it("ends with a scheduling example and the rollback safety line", async () => {
    const out: string[] = [];
    const io: ProgramIO = {
      fetch: (() => Promise.reject(new Error("no network in test"))) as typeof globalThis.fetch,
      stderr: () => undefined,
      stdout: (s) => out.push(s)
    };
    const program = new Command();
    registerOnboardCommand(program, io);
    await program.parseAsync(["node", "muse", "onboard"]);
    const text = out.join("");
    expect(text).toContain("muse scheduler add");
    expect(text).toContain("muse rollback");
    expect(text).toContain("undoable");
  });
});
