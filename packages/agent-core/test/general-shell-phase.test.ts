import { describe, expect, it } from "vitest";

import {
  GeneralShellPhaseGate,
  GENERAL_SHELL_TOOL_NAMES,
  STRUCTURED_FILE_WRITE_TOOL_NAMES
} from "../src/index.js";

// Phase-scoped tool discipline (eval:multifile-fix RED probe): a general shell
// (run_command) cannibalizes the structured file tools on a small model — it
// "reads" via cat/ls/find instead of file_read/file_grep and never lands a
// file_edit. The gate withholds the shell during the fix phase.

const LANDED = JSON.stringify({ edits: 1, path: "/tmp/x.mjs", written: true });
const REFUSED = JSON.stringify({ path: "/tmp/x.mjs", reason: "2 matches — ambiguous", written: false });

describe("GeneralShellPhaseGate", () => {
  it("engages only when BOTH a general shell AND a structured file-write tool are exposed", () => {
    const both = new GeneralShellPhaseGate(["run_command", "file_read", "file_edit"]);
    both.record("run_command", "{}");
    expect(both.withholds("run_command")).toBe(true);

    // Shell alone (the execute eval) — never engages, never withholds.
    const shellOnly = new GeneralShellPhaseGate(["run_command", "file_read", "file_grep"]);
    shellOnly.record("run_command", "{}");
    expect(shellOnly.withholds("run_command")).toBe(false);

    // File tools alone (the one-file loop has no shell) — never engages.
    const fileOnly = new GeneralShellPhaseGate(["file_read", "file_grep", "file_edit"]);
    fileOnly.record("file_edit", REFUSED);
    expect(fileOnly.withholds("file_edit")).toBe(false);
  });

  it("does NOT withhold the shell before it has been used (initial test run is allowed)", () => {
    const gate = new GeneralShellPhaseGate(["run_command", "file_edit"]);
    expect(gate.withholds("run_command")).toBe(false);
  });

  it("withholds the shell after it is used (opens the fix phase)", () => {
    const gate = new GeneralShellPhaseGate(["run_command", "file_edit"]);
    gate.record("run_command", "TEST FAIL: multiply returned 7");
    expect(gate.withholds("run_command")).toBe(true);
  });

  it("only the shell is withheld — file tools stay available mid-fix-phase", () => {
    const gate = new GeneralShellPhaseGate(["run_command", "file_read", "file_grep", "file_edit"]);
    gate.record("run_command", "{}");
    expect(gate.withholds("run_command")).toBe(true);
    expect(gate.withholds("file_read")).toBe(false);
    expect(gate.withholds("file_grep")).toBe(false);
    expect(gate.withholds("file_edit")).toBe(false);
  });

  it("a LANDED file write re-arms the shell (confirm the fix)", () => {
    const gate = new GeneralShellPhaseGate(["run_command", "file_edit"]);
    gate.record("run_command", "TEST FAIL");
    expect(gate.withholds("run_command")).toBe(true);
    gate.record("file_edit", LANDED);
    expect(gate.withholds("run_command")).toBe(false);
  });

  it("a REFUSED edit (written:false) does NOT re-arm the shell — the escape hatch stays closed", () => {
    const gate = new GeneralShellPhaseGate(["run_command", "file_edit"]);
    gate.record("run_command", "TEST FAIL");
    gate.record("file_edit", REFUSED);
    expect(gate.withholds("run_command")).toBe(true);
  });

  it("re-closes the fix phase when the shell is used again after a landed write", () => {
    const gate = new GeneralShellPhaseGate(["run_command", "file_edit"]);
    gate.record("run_command", "TEST FAIL"); // open
    gate.record("file_edit", LANDED); // re-arm
    gate.record("run_command", "TEST PASS"); // confirm run — opens again
    expect(gate.withholds("run_command")).toBe(true);
  });

  it("recognizes the file_multi_edit / file_write success markers too", () => {
    for (const writeTool of ["file_multi_edit", "file_write"]) {
      const gate = new GeneralShellPhaseGate(["run_command", writeTool]);
      gate.record("run_command", "{}");
      expect(gate.withholds("run_command")).toBe(true);
      gate.record(writeTool, JSON.stringify({ written: true }));
      expect(gate.withholds("run_command")).toBe(false);
    }
  });

  it("tolerates whitespace in the success marker", () => {
    const gate = new GeneralShellPhaseGate(["run_command", "file_edit"]);
    gate.record("run_command", "{}");
    gate.record("file_edit", '{ "written" : true }');
    expect(gate.withholds("run_command")).toBe(false);
  });

  it("exports the tool-name sets", () => {
    expect(GENERAL_SHELL_TOOL_NAMES.has("run_command")).toBe(true);
    expect(STRUCTURED_FILE_WRITE_TOOL_NAMES.has("file_edit")).toBe(true);
    expect(STRUCTURED_FILE_WRITE_TOOL_NAMES.has("file_multi_edit")).toBe(true);
    expect(STRUCTURED_FILE_WRITE_TOOL_NAMES.has("file_write")).toBe(true);
  });
});
