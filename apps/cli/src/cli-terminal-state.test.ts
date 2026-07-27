import { describe, expect, it } from "vitest";

import {
  CLI_EXIT_CODES,
  classifyApiTerminalState,
  classifyCliTerminalState,
  CliTerminalStateError,
  commandNameFromArgv,
  jsonModeRequested,
  jsonTerminalFailure,
  setCliTerminalState,
  terminalStateFromExitCode
} from "./cli-terminal-state.js";

describe("canonical CLI terminal-state contract", () => {
  it("reserves one stable exit code for each terminal state", () => {
    expect(CLI_EXIT_CODES).toEqual({
      success: 0,
      "internal-failure": 1,
      "user-error": 2,
      "policy-block": 3,
      unverified: 4
    });
    expect([0, 1, 2, 3, 4].map(terminalStateFromExitCode)).toEqual([
      "success",
      "internal-failure",
      "user-error",
      "policy-block",
      "unverified"
    ]);
    expect(terminalStateFromExitCode(130)).toBe("internal-failure");
  });

  it("classifies API policy, validation, unavailable, and internal failures without flattening", () => {
    expect(classifyApiTerminalState(403, "GUARD_BLOCKED")).toBe("policy-block");
    expect(classifyApiTerminalState(403, "INJECTION_DETECTED")).toBe("policy-block");
    expect(classifyApiTerminalState(403, "AUTH_FORBIDDEN")).toBe("user-error");
    expect(classifyApiTerminalState(400, "INVALID_ARGUMENT")).toBe("user-error");
    expect(classifyApiTerminalState(408)).toBe("unverified");
    expect(classifyApiTerminalState(504)).toBe("unverified");
    expect(classifyApiTerminalState(503, "UPSTREAM_UNAVAILABLE")).toBe("unverified");
    expect(classifyApiTerminalState(503, "AGENT_RUNTIME_UNAVAILABLE")).toBe("unverified");
    expect(classifyApiTerminalState(503, "UNKNOWN_UNAVAILABLE")).toBe("internal-failure");
    expect(classifyApiTerminalState(500, "AGENT_RUN_FAILED")).toBe("internal-failure");
  });

  it("classifies typed, Commander, user, syntax, and programmer errors", () => {
    expect(classifyCliTerminalState(new CliTerminalStateError("unverified", "offline"))).toBe("unverified");
    expect(classifyCliTerminalState({ code: "commander.invalidArgument", exitCode: 1 })).toBe("user-error");
    expect(classifyCliTerminalState({ code: "commander.helpDisplayed", exitCode: 0 })).toBe("success");
    expect(classifyCliTerminalState(new Error("bad user input"))).toBe("user-error");
    expect(classifyCliTerminalState(new SyntaxError("bad json"))).toBe("user-error");
    expect(classifyCliTerminalState(new TypeError("bug"))).toBe("internal-failure");
    expect(classifyCliTerminalState(undefined)).toBe("internal-failure");
  });

  it("sets exit state through the shared mapper and preserves reserved signal codes outside it", () => {
    const target: { exitCode?: number | string | null } = {};
    setCliTerminalState("policy-block", target);
    expect(target.exitCode).toBe(3);
    expect(terminalStateFromExitCode(130)).toBe("internal-failure");
    expect(terminalStateFromExitCode(143)).toBe("internal-failure");
  });

  it("emits one privacy-safe JSON failure envelope", () => {
    const line = jsonTerminalFailure(
      new CliTerminalStateError(
        "policy-block",
        "Authorization: Bearer ya29.A0AbCdEfGhIjKlMnOpQrStUvWxYz",
        "GUARD_BLOCKED"
      ),
      "policy-block",
      { command: "chat" }
    );
    expect(line.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(line)).toEqual({
      schemaVersion: 1,
      ok: false,
      terminalState: "policy-block",
      exitCode: 3,
      command: "chat",
      error: {
        code: "GUARD_BLOCKED",
        message: expect.not.stringContaining("ya29.")
      }
    });
    expect(jsonModeRequested(["node", "muse", "qualify", "--json"])).toBe(true);
    expect(jsonModeRequested(["node", "muse", "qualify"])).toBe(false);
    expect(commandNameFromArgv(["node", "muse", "--api-url", "http://127.0.0.1:1", "mcp", "status"])).toBe("mcp");
    expect(commandNameFromArgv(["node", "muse", "--token=private", "chat"])).toBe("chat");
  });
});
