import { describe, expect, it } from "vitest";

import { evaluateLocalOnlyPosture } from "../src/setup-status.js";

describe("evaluateLocalOnlyPosture — single source of truth for doctor + setup status", () => {
  it("ON + a local model ⇒ ok, egress blocked", () => {
    const p = evaluateLocalOnlyPosture({ MUSE_LOCAL_ONLY: "true", MUSE_MODEL: "ollama/llama3.2" });
    expect(p).toMatchObject({ enabled: true, status: "ok" });
    expect(p.detail).toContain("blocked");
  });

  it("ON + an EXPLICIT cloud model ⇒ fail with the runtime's own refusal reason", () => {
    const p = evaluateLocalOnlyPosture({ MUSE_LOCAL_ONLY: "true", MUSE_MODEL: "gemini/gemini-2.0-flash", GEMINI_API_KEY: "k" });
    expect(p).toMatchObject({ enabled: true, status: "fail" });
    expect(p.detail).toContain("MUSE_LOCAL_ONLY");
  });

  it("ON + an ambient cloud key but NO explicit model ⇒ ok (default resolves local, nothing leaks)", () => {
    const p = evaluateLocalOnlyPosture({ MUSE_LOCAL_ONLY: "true", GEMINI_API_KEY: "k" });
    expect(p).toMatchObject({ enabled: true, status: "ok" });
  });

  it("explicit OFF (opt-out) + cloud credentials ⇒ warn that egress is possible", () => {
    const p = evaluateLocalOnlyPosture({ MUSE_LOCAL_ONLY: "false", OPENAI_API_KEY: "k" });
    expect(p).toMatchObject({ enabled: false, status: "warn" });
    expect(p.detail).toContain("OPENAI_API_KEY");
    expect(p.detail).toContain("off");
  });

  it("explicit OFF (opt-out) + no cloud credentials ⇒ ok (nothing to leak)", () => {
    const p = evaluateLocalOnlyPosture({ MUSE_LOCAL_ONLY: "false", MUSE_MODEL: "ollama/llama3.2" });
    expect(p).toMatchObject({ enabled: false, status: "ok" });
    expect(p.detail).toContain("off");
  });

  it("DEFAULT (unset) ⇒ local-only is OFF, cloud allowed (no key ⇒ nothing to leak)", () => {
    const p = evaluateLocalOnlyPosture({ MUSE_MODEL: "ollama/llama3.2" });
    expect(p).toMatchObject({ enabled: false, status: "ok" });
    expect(p.detail).toContain("off");
  });

  // The embedder reads OLLAMA_BASE_URL independently of the chat model, so a
  // LOCAL non-ollama chat (lmstudio) + a REMOTE OLLAMA_BASE_URL passes the chat
  // router gate (which only checks OLLAMA_BASE_URL when the CHAT provider is
  // ollama) while the embedder would egress the user's text — this fail-closes
  // at runtime, but doctor must SURFACE it (not report a false "🔒 ok").
  it("ON + a LOCAL lmstudio chat but a REMOTE OLLAMA_BASE_URL ⇒ fail (embedder egress surfaced)", () => {
    const p = evaluateLocalOnlyPosture({ MUSE_LOCAL_ONLY: "true", MUSE_MODEL: "lmstudio/llama", OLLAMA_BASE_URL: "http://192.168.1.50:11434" });
    expect(p).toMatchObject({ enabled: true, status: "fail" });
    expect(p.detail).toContain("OLLAMA_BASE_URL");
  });

  it("ON + a LOCAL lmstudio chat + a LOOPBACK OLLAMA_BASE_URL ⇒ ok (embedder stays on-box)", () => {
    const p = evaluateLocalOnlyPosture({ MUSE_LOCAL_ONLY: "true", MUSE_MODEL: "lmstudio/llama", OLLAMA_BASE_URL: "http://127.0.0.1:11434" });
    expect(p).toMatchObject({ enabled: true, status: "ok" });
  });

  it("explicit OFF (opt-out) + a remote OLLAMA_BASE_URL ⇒ NOT flagged by the embedder check (opt-out preserved)", () => {
    const p = evaluateLocalOnlyPosture({ MUSE_LOCAL_ONLY: "false", MUSE_MODEL: "ollama/llama3.2", OLLAMA_BASE_URL: "http://192.168.1.50:11434" });
    expect(p).toMatchObject({ enabled: false, status: "ok" });
  });
});
