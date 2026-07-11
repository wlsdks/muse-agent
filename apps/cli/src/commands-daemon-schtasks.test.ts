import { describe, expect, it } from "vitest";

import { buildSchtasksCreateArgs, buildSchtasksDeleteArgs, buildSchtasksQueryArgs, SCHTASKS_TASK_NAME } from "./commands-daemon-schtasks.js";

describe("schtasks arg builders", () => {
  it("create registers an ONLOGON task with the quoted program line", () => {
    const args = buildSchtasksCreateArgs({
      programArguments: ["C:\\Program Files\\nodejs\\node.exe", "C:\\muse\\cli.js", "daemon"],
      taskName: SCHTASKS_TASK_NAME
    });
    expect(args).toEqual([
      "/Create", "/F", "/SC", "ONLOGON", "/TN", "MuseDaemon",
      "/TR", '"C:\\Program Files\\nodejs\\node.exe" C:\\muse\\cli.js daemon'
    ]);
  });

  it("space-free arguments stay unquoted", () => {
    const args = buildSchtasksCreateArgs({ programArguments: ["node", "cli.js", "daemon"], taskName: "T" });
    expect(args[args.indexOf("/TR") + 1]).toBe("node cli.js daemon");
  });

  it("delete and query target the task by name", () => {
    expect(buildSchtasksDeleteArgs("MuseDaemon")).toEqual(["/Delete", "/F", "/TN", "MuseDaemon"]);
    expect(buildSchtasksQueryArgs("MuseDaemon")).toEqual(["/Query", "/TN", "MuseDaemon"]);
  });
});
