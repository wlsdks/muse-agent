import { describe, expect, it } from "vitest";

import { classifyDangerousCommand, parseRunnerCommandRequest } from "../src/index.js";

describe("classifyDangerousCommand", () => {
  it("flags irreversible catastrophic commands", () => {
    for (const cmd of [
      "rm -rf /",
      "rm -rf /*",
      "rm -rf ~",
      "rm -rf ~/",
      "sudo rm -rf /",
      "rm -fr $HOME",
      ":(){ :|:& };:",
      "dd if=/dev/zero of=/dev/sda",
      "dd if=/dev/zero of=/dev/disk2 bs=1m",
      "mkfs.ext4 /dev/sdb1",
      "wipefs -a /dev/sda",
      "echo x > /dev/sda",
      "chmod -R 777 /",
      "chmod -R 755 ~",
      "sudo chmod -R u+rwx /*",
      "chown -R nobody /",
      "chown -R user:group ~/"
    ]) {
      expect(classifyDangerousCommand(cmd).dangerous, cmd).toBe(true);
    }
  });

  it("does NOT flag reversible / routine commands", () => {
    for (const cmd of [
      "rm -rf ./build",
      "rm -rf node_modules",
      "rm -rf dist/cache",
      "ls -la /",
      "cat /etc/hosts",
      "npm test",
      "git status",
      "dd if=input.img of=output.img",
      "echo hello > out.txt",
      "chmod -R 755 ./dist",
      "chmod +x ./script.sh",
      "chown -R me ./project"
    ]) {
      expect(classifyDangerousCommand(cmd).dangerous, cmd).toBe(false);
    }
  });

  it("returns a human reason for a flagged command", () => {
    expect(classifyDangerousCommand("rm -rf /").reason).toMatch(/root or home/);
  });
});

describe("parseRunnerCommandRequest fail-closes on a catastrophic command", () => {
  it("refuses rm -rf / packed in the command string", () => {
    expect(() => parseRunnerCommandRequest({ command: "rm -rf /" })).toThrow(/refused/);
  });

  it("refuses when -rf / is split across command + args", () => {
    expect(() => parseRunnerCommandRequest({ command: "rm", args: ["-rf", "/"] })).toThrow(/refused/);
  });

  it("allows a safe relative recursive delete", () => {
    expect(parseRunnerCommandRequest({ command: "rm -rf ./build" }).command).toBe("rm");
  });
});
