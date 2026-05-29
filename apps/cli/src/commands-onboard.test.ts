import { describe, expect, it } from "vitest";

import { computeOnboarding, type OnboardingState } from "./commands-onboard.js";

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
});
