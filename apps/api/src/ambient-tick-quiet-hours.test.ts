import { resolveEffectiveQuietHours } from "@muse/proactivity";
import { describe, expect, it } from "vitest";

import { startAmbientTick } from "./ambient-tick.js";

import type { MessagingProviderRegistry } from "@muse/messaging";
import type { AmbientNoticeRule, AmbientSignalSource } from "@muse/proactivity";

/**
 * R3-4 AC3 — "pick ONE loop, e.g. ambient, and prove equivalence env-vs-
 * persisted with the same fixture." `resolveEffectiveQuietHours` is the ONE
 * shared resolver both the env path (a per-loop or base env var) and the
 * persisted path (the daemon-settings-store setting, enabled) funnel through
 * — this proves the SAME window suppresses ambient delivery identically
 * regardless of which source produced it, against the real `startAmbientTick`
 * (not a re-derivation of its gating logic).
 */

function fakeRegistry(sent: string[]): MessagingProviderRegistry {
  return {
    send: async (_providerId: string, message: { readonly destination: string; readonly text: string }) => {
      sent.push(message.text);
      return { ok: true };
    }
  } as unknown as MessagingProviderRegistry;
}

const rules: readonly AmbientNoticeRule[] = [
  { id: "r1", match: { app: "Notes" }, message: "you're in Notes", title: "Ambient" }
];
const source: AmbientSignalSource = { snapshot: () => ({ app: "Notes" }) };

async function runFixture(quietHours: ReturnType<typeof resolveEffectiveQuietHours>): Promise<{ readonly duringWindow: readonly string[]; readonly afterWindow: readonly string[] }> {
  let hour = 23; // inside the 23-8 window
  const sent: string[] = [];
  const handle = startAmbientTick({
    destination: "@me",
    now: () => new Date(2026, 0, 1, hour, 0, 0),
    providerId: "log",
    ...(quietHours ? { quietHours } : {}),
    registry: fakeRegistry(sent),
    rules,
    source
  });
  await handle.tickOnce();
  const duringWindow = [...sent];
  sent.length = 0;
  hour = 10; // outside the window — the still-matching rule is a fresh rising edge
  await handle.tickOnce();
  const afterWindow = [...sent];
  handle.stop();
  return { afterWindow, duringWindow };
}

describe("R3-4 AC3 — ambient quiet-hours: env-resolved and persisted-resolved windows are equivalent", () => {
  it("resolveEffectiveQuietHours produces the SAME window from an env raw string and an enabled persisted setting", () => {
    const fromEnv = resolveEffectiveQuietHours({ perLoopEnvRaw: "23-8" });
    const fromPersisted = resolveEffectiveQuietHours({ persisted: { enabled: true, range: "23-8" } });
    expect(fromEnv).toEqual({ endHour: 8, startHour: 23 });
    expect(fromPersisted).toEqual(fromEnv);
  });

  it("both the env-resolved and the persisted-resolved window suppress ambient delivery identically against the SAME fixture", async () => {
    const fromEnv = resolveEffectiveQuietHours({ perLoopEnvRaw: "23-8" });
    const fromPersisted = resolveEffectiveQuietHours({ persisted: { enabled: true, range: "23-8" } });

    const envResult = await runFixture(fromEnv);
    const persistedResult = await runFixture(fromPersisted);

    expect(envResult).toEqual(persistedResult);
    expect(envResult.duringWindow).toHaveLength(0); // held during quiet hours
    expect(envResult.afterWindow).toHaveLength(1); // fires once the window ends
  });

  it("an invalid persisted range resolves to undefined (fail-soft, never suppresses)", () => {
    const resolved = resolveEffectiveQuietHours({ persisted: { enabled: true, range: "not-a-range" } });
    expect(resolved).toBeUndefined();
  });

  it("invalid persisted range is reported to onInvalidPersisted exactly once per call, with the raw string", () => {
    const seen: string[] = [];
    resolveEffectiveQuietHours({
      onInvalidPersisted: (raw) => seen.push(raw),
      persisted: { enabled: true, range: "garbage" }
    });
    expect(seen).toEqual(["garbage"]);
  });

  it("env precedence: a per-loop env var wins over an enabled persisted setting with a DIFFERENT window", () => {
    const resolved = resolveEffectiveQuietHours({
      perLoopEnvRaw: "1-2",
      persisted: { enabled: true, range: "23-8" }
    });
    expect(resolved).toEqual({ endHour: 2, startHour: 1 });
  });

  it("base env wins over the persisted setting when no per-loop var is set", () => {
    const resolved = resolveEffectiveQuietHours({
      baseEnvRaw: "1-2",
      persisted: { enabled: true, range: "23-8" }
    });
    expect(resolved).toEqual({ endHour: 2, startHour: 1 });
  });

  it("a persisted setting with enabled:false is ignored even if its range is valid", () => {
    const resolved = resolveEffectiveQuietHours({ persisted: { enabled: false, range: "23-8" } });
    expect(resolved).toBeUndefined();
  });
});
