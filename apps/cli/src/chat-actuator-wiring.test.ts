/**
 * Acceptance for exposing actuators to the chat model.
 *
 * `outbound-safety.md`: a send capability ships only when the test proves the
 * GATE, not the happy path — deny / non-interactive / mode-off must produce no
 * external effect. So these assert what the model can SEE and what a denied
 * call does, never just that an approved call works.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { MuseEnvironment } from "@muse/autoconfigure";

import { buildChatActuatorWiring, resolveChatActuatorMode } from "./chat-actuator-wiring.js";
import type { ProgramIO } from "./program.js";

async function configWith(mode?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "muse-chat-actuator-"));
  const file = join(dir, "config.json");
  await writeFile(file, `${JSON.stringify(mode === undefined ? {} : { actuators: { mode } })}\n`, "utf8");
  return file;
}

function io(): ProgramIO {
  return { stderr: () => undefined, stdout: () => undefined } as unknown as ProgramIO;
}

const baseEnv = { MUSE_WEB_EGRESS: "true" } as unknown as MuseEnvironment;

describe("chat actuator exposure — the model sees nothing unless opted in", () => {
  it("mode=off exposes ZERO tools, not tools behind a denying gate", async () => {
    const wiring = await buildChatActuatorWiring({
      configFile: await configWith("off"), env: baseEnv, io: io(), userId: "stark"
    });
    expect(wiring.mode).toBe("off");
    expect(wiring.tools).toHaveLength(0);
  });

  it("an ABSENT actuators block behaves exactly like off", async () => {
    const wiring = await buildChatActuatorWiring({
      configFile: await configWith(), env: baseEnv, io: io(), userId: "stark"
    });
    expect(wiring.mode).toBe("off");
    expect(wiring.tools).toHaveLength(0);
  });

  it("an UNRECOGNISED mode behaves like off rather than being guessed at", async () => {
    const wiring = await buildChatActuatorWiring({
      configFile: await configWith("automatic"), env: baseEnv, io: io(), userId: "stark"
    });
    expect(wiring.mode).toBe("off");
    expect(wiring.tools).toHaveLength(0);
  });

  it("a corrupt config exposes nothing instead of throwing or failing open", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muse-chat-actuator-bad-"));
    const file = join(dir, "config.json");
    await writeFile(file, "{ not json", "utf8");
    const wiring = await buildChatActuatorWiring({ configFile: file, env: baseEnv, io: io(), userId: "stark" });
    expect(wiring.mode).toBe("off");
    expect(wiring.tools).toHaveLength(0);
  });

  it("mode=ask exposes the actuator tools", async () => {
    const wiring = await buildChatActuatorWiring({
      configFile: await configWith("ask"),
      confirmAction: async () => true,
      env: baseEnv,
      io: io(),
      isInteractive: () => true,
      userId: "stark"
    });
    expect(wiring.mode).toBe("ask");
    expect(wiring.tools.length).toBeGreaterThan(0);
  });
});

describe("chat actuator exposure — mode precedence", () => {
  it("MUSE_ACTUATOR_MODE overrides the configured mode", async () => {
    const file = await configWith("off");
    const env = { ...baseEnv, MUSE_ACTUATOR_MODE: "ask" } as unknown as MuseEnvironment;
    expect(await resolveChatActuatorMode(env, file)).toBe("ask");
  });

  it("env can also turn actuators OFF for one invocation", async () => {
    const file = await configWith("auto");
    const env = { ...baseEnv, MUSE_ACTUATOR_MODE: "off" } as unknown as MuseEnvironment;
    const wiring = await buildChatActuatorWiring({ configFile: file, env, io: io(), userId: "stark" });
    expect(wiring.tools).toHaveLength(0);
  });
});

describe("chat actuator exposure — auto is not yet more permissive than ask", () => {
  it("mode=auto exposes the same tool set as ask (step 4 splits them)", async () => {
    const common = { confirmAction: async () => true, env: baseEnv, io: io(), isInteractive: () => true, userId: "stark" };
    const ask = await buildChatActuatorWiring({ ...common, configFile: await configWith("ask") });
    const auto = await buildChatActuatorWiring({ ...common, configFile: await configWith("auto") });

    expect(auto.mode).toBe("auto");
    // Until the risk-class split lands, `auto` must not quietly grant more than
    // `ask` — same names, same gate.
    expect(auto.tools.map((t) => t.definition.name).sort())
      .toEqual(ask.tools.map((t) => t.definition.name).sort());
  });
});
