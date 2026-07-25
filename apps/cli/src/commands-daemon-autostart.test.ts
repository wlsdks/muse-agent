import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  inspectDaemonAutostart,
  inspectScheduledTaskArtifact,
  parseLaunchAgentEnvironmentVariables,
  parseLaunchAgentProgramArguments,
  parseLaunchctlPrintSnapshot
} from "./commands-daemon-autostart.js";
import { buildLaunchAgentPlist } from "./commands-daemon-launchagent.js";

function stableCliPackage(): string {
  const packageRoot = mkdtempSync(join(tmpdir(), "muse-scheduled-task-cli-"));
  const entry = join(packageRoot, "dist", "index.js");
  mkdirSync(join(packageRoot, "dist"), { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
    bin: { muse: "./dist/index.js" },
    name: "@muse/cli"
  }));
  writeFileSync(entry, "export {};\n");
  return entry;
}

function taskXml(entrypoint: string, executable = process.execPath): string {
  const escapedEntry = entrypoint.replaceAll("&", "&amp;").replaceAll("\"", "&quot;");
  const escapedExecutable = executable.replaceAll("&", "&amp;");
  return `<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Actions Context="Author"><Exec><Command>${escapedExecutable}</Command><Arguments>&quot;${escapedEntry}&quot; daemon</Arguments></Exec></Actions></Task>`;
}

function prefixedTaskXml(entrypoint: string): string {
  const escapedEntry = entrypoint.replaceAll("&", "&amp;").replaceAll("\"", "&quot;");
  return `<evil:Task xmlns:evil="urn:evil"><evil:Actions><evil:Exec><evil:Command>${process.execPath}</evil:Command><evil:Arguments>&quot;${escapedEntry}&quot; daemon</evil:Arguments></evil:Exec></evil:Actions></evil:Task>`;
}

describe("LaunchAgent qualification parsers", () => {
  it("parses the exact EnvironmentVariables dictionary Muse persists", () => {
    const plist = buildLaunchAgentPlist({
      environmentVariables: {
        MUSE_DAEMON_DELIVERY_ENABLED: "false",
        MUSE_DAEMON_PROVIDER_LOCK: "log",
        MUSE_LOCAL_ONLY: "true",
        MUSE_SELFLEARN_ENABLED: "false"
      },
      label: "com.muse.daemon",
      programArguments: ["/opt/node", "/opt/muse/index.js", "daemon"],
      stderrPath: "/tmp/muse.err.log",
      stdoutPath: "/tmp/muse.out.log"
    });

    expect(parseLaunchAgentEnvironmentVariables(plist)).toEqual({
      MUSE_DAEMON_DELIVERY_ENABLED: "false",
      MUSE_DAEMON_PROVIDER_LOCK: "log",
      MUSE_LOCAL_ONLY: "true",
      MUSE_SELFLEARN_ENABLED: "false"
    });
  });

  it("rejects duplicate keys and non-string values instead of partially parsing them", () => {
    const duplicate = `
      <key>EnvironmentVariables</key>
      <dict>
        <key>MUSE_LOCAL_ONLY</key><string>true</string>
        <key>MUSE_LOCAL_ONLY</key><string>false</string>
      </dict>`;
    const nonString = `
      <key>EnvironmentVariables</key>
      <dict><key>MUSE_LOCAL_ONLY</key><true/></dict>`;

    expect(parseLaunchAgentEnvironmentVariables(duplicate)).toBeUndefined();
    expect(parseLaunchAgentEnvironmentVariables(nonString)).toBeUndefined();
  });

  it("rejects duplicate or partially non-string ProgramArguments", () => {
    const valid = `<key>ProgramArguments</key><array><string>/node</string><string>/muse.js</string><string>daemon</string></array>`;
    expect(parseLaunchAgentProgramArguments(valid)).toEqual(["/node", "/muse.js", "daemon"]);
    expect(parseLaunchAgentProgramArguments(`${valid}${valid}`)).toBeUndefined();
    expect(parseLaunchAgentProgramArguments(valid.replace("<string>daemon</string>", "<true/>"))).toBeUndefined();
  });

  it("merges inherited, default, and job live environments with job precedence", () => {
    const output = `gui/501/com.muse.daemon = {
      state = running
      program = /opt/node
      arguments = {
        /opt/node
        /opt/muse/index.js
        daemon
        --provider=log
      }
      inherited environment = {
        MUSE_LOCAL_ONLY => false
        MUSE_PROACTIVE_PROVIDER => remote
      }
      default environment = {
        MUSE_DAEMON_CONFIG_FILE => /tmp/manager-daemon.json
        MUSE_DAEMON_PROVIDER_LOCK => remote
      }
      environment = {
        MUSE_DAEMON_DELIVERY_ENABLED => false
        MUSE_DAEMON_PROVIDER_LOCK => log
        MUSE_LOCAL_ONLY => true
        MUSE_SELFLEARN_ENABLED => false
      }
      pid = 4321
    }`;

    expect(parseLaunchctlPrintSnapshot(output)).toEqual({
      arguments: ["/opt/node", "/opt/muse/index.js", "daemon", "--provider=log"],
      environment: {
        MUSE_DAEMON_CONFIG_FILE: "/tmp/manager-daemon.json",
        MUSE_DAEMON_DELIVERY_ENABLED: "false",
        MUSE_DAEMON_PROVIDER_LOCK: "log",
        MUSE_LOCAL_ONLY: "true",
        MUSE_PROACTIVE_PROVIDER: "remote",
        MUSE_SELFLEARN_ENABLED: "false"
      },
      pid: 4321
    });
  });

  it("rejects partial or ambiguous live launchd snapshots", () => {
    const complete = `arguments = {\n/node\n/muse.js\ndaemon\n}\nenvironment = {\nMUSE_LOCAL_ONLY => true\n}\npid = 7`;

    expect(parseLaunchctlPrintSnapshot(complete.replace("pid = 7", ""))).toBeUndefined();
    expect(parseLaunchctlPrintSnapshot(`${complete}\npid = 8`)).toBeUndefined();
    expect(parseLaunchctlPrintSnapshot(complete.replace("MUSE_LOCAL_ONLY => true", "MUSE_LOCAL_ONLY => true\nMUSE_LOCAL_ONLY => false"))).toBeUndefined();
    expect(parseLaunchctlPrintSnapshot(complete.replace("environment = {", "default environment = {"))).toBeUndefined();
    expect(parseLaunchctlPrintSnapshot(`${complete}\ndefault environment = {\nPATH => /one\n}\ndefault environment = {\nPATH => /two\n}`)).toBeUndefined();
    expect(parseLaunchctlPrintSnapshot(`${complete}\ninherited environment = {\nMUSE_LOCAL_ONLY => true\nMUSE_LOCAL_ONLY => false\n}`)).toBeUndefined();
    expect(parseLaunchctlPrintSnapshot(`${complete}\ndefault environment = [\nMUSE_PROACTIVE_PROVIDER => remote\n]`)).toBeUndefined();
  });
});

describe("Task Scheduler qualification", () => {
  it("accepts a registered task only when its XML names the stable declared Muse bin", async () => {
    const entrypoint = stableCliPackage();
    const calls: (readonly string[])[] = [];
    const status = await inspectDaemonAutostart({
      launchAgentLabel: "unused",
      platform: "win32",
      plistFile: "unused",
      scheduledTaskName: "MuseDaemon",
      schtasksQueryArgs: (name) => ["/Query", "/TN", name, "/XML"],
      schtasksRun: async (args) => {
        calls.push(args);
        return { exitCode: 0, stderr: "", stdout: taskXml(entrypoint) };
      },
      temporaryRoots: []
    });

    expect(calls).toEqual([["/Query", "/TN", "MuseDaemon", "/XML"]]);
    expect(status).toMatchObject({
      artifact: { entrypoint: realpathSync(entrypoint), state: "valid" },
      kind: "win32",
      registration: "registered"
    });
  });

  it("classifies registered tasks with missing, arbitrary, or ambiguous actions as stale or invalid", () => {
    const arbitrary = join(mkdtempSync(join(tmpdir(), "muse-scheduled-task-arbitrary-")), "entry.js");
    writeFileSync(arbitrary, "export {};\n");
    expect(inspectScheduledTaskArtifact(taskXml(arbitrary), [])).toMatchObject({
      reason: expect.stringContaining("declared muse bin"),
      state: "stale-entrypoint"
    });
    expect(inspectScheduledTaskArtifact(taskXml(`${arbitrary}.missing`), [])).toMatchObject({
      reason: expect.stringContaining("does not exist"),
      state: "stale-entrypoint"
    });
    expect(inspectScheduledTaskArtifact(
      taskXml(arbitrary).replace("</Actions>", "<Exec><Command>/other</Command><Arguments>x</Arguments></Exec></Actions>"),
      []
    )).toMatchObject({ state: "invalid" });
    expect(inspectScheduledTaskArtifact(`<Broken>${taskXml(arbitrary)}`, [])).toMatchObject({ state: "invalid" });
    expect(inspectScheduledTaskArtifact(`<Other/>${taskXml(arbitrary)}`, [])).toMatchObject({ state: "invalid" });
    expect(inspectScheduledTaskArtifact(`${taskXml(arbitrary)}<Other/>`, [])).toMatchObject({ state: "invalid" });
    expect(inspectScheduledTaskArtifact(
      taskXml(arbitrary).replace("</Actions>", "<Bogus/></Actions>"),
      []
    )).toMatchObject({ state: "invalid" });
    expect(inspectScheduledTaskArtifact(
      taskXml(arbitrary).replace("</Task>", "<Bogus/></Task>"),
      []
    )).toMatchObject({ state: "invalid" });
    expect(inspectScheduledTaskArtifact(
      taskXml(arbitrary).replace(
        "<Actions Context=\"Author\">",
        "<RegistrationInfo xmlns=\"urn:evil\"><Description>spoof</Description></RegistrationInfo><Actions Context=\"Author\">"
      ),
      []
    )).toMatchObject({ state: "invalid" });
    expect(inspectScheduledTaskArtifact(
      taskXml(arbitrary).replace("</Exec>", "<WorkingDirectory>/tmp</WorkingDirectory></Exec>"),
      []
    )).toMatchObject({ state: "invalid" });
  });

  it("distinguishes a missing task from an unverified Task Scheduler query failure", async () => {
    const base = {
      launchAgentLabel: "unused",
      platform: "win32" as const,
      plistFile: "unused",
      scheduledTaskName: "MuseDaemon",
      schtasksQueryArgs: (name: string) => ["/Query", "/TN", name, "/XML"]
    };
    const missing = await inspectDaemonAutostart({
      ...base,
      schtasksRun: async () => ({ exitCode: 1, stderr: "ERROR: The system cannot find the file specified.", stdout: "" })
    });
    const denied = await inspectDaemonAutostart({
      ...base,
      schtasksRun: async () => ({ exitCode: 5, stderr: "ERROR: Access is denied.", stdout: "" })
    });
    const rpcNotFound = await inspectDaemonAutostart({
      ...base,
      schtasksRun: async () => ({ exitCode: 1, stderr: "RPC endpoint not found; access denied", stdout: "" })
    });
    const userNotFound = await inspectDaemonAutostart({
      ...base,
      schtasksRun: async () => ({ exitCode: 1, stderr: "User account not found; access denied", stdout: "" })
    });
    const embeddedMissingPhrase = await inspectDaemonAutostart({
      ...base,
      schtasksRun: async () => ({
        exitCode: 1,
        stderr: "RPC failed: The system cannot find the file specified; access denied",
        stdout: ""
      })
    });
    const otherTask = await inspectDaemonAutostart({
      ...base,
      schtasksRun: async () => ({
        exitCode: 1,
        stderr: "ERROR: The specified task name \"OtherTask\" does not exist.",
        stdout: ""
      })
    });
    const nearMisses = await Promise.all([
      "The system cannot find the file specified",
      "ERROR: the system cannot find the file specified",
      "ERROR:   The system cannot find the file specified",
      "ERROR: The system cannot find the file specified"
    ].map(async (stderr) => inspectDaemonAutostart({
      ...base,
      schtasksRun: async () => ({ exitCode: 1, stderr, stdout: "" })
    })));

    expect(missing).toMatchObject({ artifact: { state: "missing" }, registration: "not-registered" });
    expect(denied).toMatchObject({ artifact: { state: "unknown" }, registration: "unknown" });
    expect(rpcNotFound).toMatchObject({ artifact: { state: "unknown" }, registration: "unknown" });
    expect(userNotFound).toMatchObject({ artifact: { state: "unknown" }, registration: "unknown" });
    expect(embeddedMissingPhrase).toMatchObject({ artifact: { state: "unknown" }, registration: "unknown" });
    expect(otherTask).toMatchObject({ artifact: { state: "unknown" }, registration: "unknown" });
    for (const nearMiss of nearMisses) {
      expect(nearMiss).toMatchObject({ artifact: { state: "unknown" }, registration: "unknown" });
    }
  });

  it("rejects wrong namespaces, unknown structural attributes, and non-Node commands", () => {
    const entrypoint = stableCliPackage();
    const valid = taskXml(entrypoint);
    expect(inspectScheduledTaskArtifact(
      valid.replace(` xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"`, ""),
      []
    )).toMatchObject({ state: "invalid" });
    expect(inspectScheduledTaskArtifact(
      valid.replace("http://schemas.microsoft.com/windows/2004/02/mit/task", "urn:evil"),
      []
    )).toMatchObject({ state: "invalid" });
    expect(inspectScheduledTaskArtifact(prefixedTaskXml(entrypoint), [])).toMatchObject({ state: "invalid" });
    expect(inspectScheduledTaskArtifact(
      valid.replace("<Actions Context=\"Author\">", "<Actions Context=\"Author\" Bogus=\"1\">"),
      []
    )).toMatchObject({ state: "invalid" });
    expect(inspectScheduledTaskArtifact(
      valid.replace("<Exec>", "<Exec Bogus=\"1\">"),
      []
    )).toMatchObject({ state: "invalid" });
    for (const malformedSettings of [
      "<Settings><Evil/></Settings>",
      "<Settings Evil=\"1\"/>",
      "<Settings><Enabled>true</Enabled><Enabled>false</Enabled></Settings>"
    ]) {
      expect(inspectScheduledTaskArtifact(
        valid.replace("<Actions", `${malformedSettings}<Actions`),
        []
      )).toMatchObject({ state: "invalid" });
    }
    for (const malformedSupportingSection of [
      "<RegistrationInfo><Evil/></RegistrationInfo>",
      "<RegistrationInfo><Author>one</Author><Author>two</Author></RegistrationInfo>",
      "<Principals><Principal><Evil/></Principal></Principals>",
      "<Triggers><LogonTrigger Evil=\"1\"/></Triggers>",
      "<Data><Evil/></Data>"
    ]) {
      expect(inspectScheduledTaskArtifact(
        valid.replace("<Actions", `${malformedSupportingSection}<Actions`),
        []
      )).toMatchObject({ state: "invalid" });
    }
    expect(inspectScheduledTaskArtifact(
      valid.replace("<Actions", [
        "<RegistrationInfo><Author>Muse</Author><URI>\\MuseDaemon</URI></RegistrationInfo>",
        "<Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>",
        "<Principals><Principal id=\"Author\"><UserId>user</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>",
        "<Settings><Enabled>true</Enabled><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><IdleSettings><StopOnIdleEnd>true</StopOnIdleEnd></IdleSettings></Settings>",
        "<Actions"
      ].join("")),
      []
    )).toMatchObject({ state: "valid" });
    expect(inspectScheduledTaskArtifact(taskXml(entrypoint, "/usr"), [])).toMatchObject({
      reason: expect.stringContaining("not a regular file"),
      state: "stale-entrypoint"
    });
    expect(inspectScheduledTaskArtifact(taskXml(entrypoint, entrypoint), [])).toMatchObject({
      reason: expect.stringContaining("does not match the current Node runtime"),
      state: "stale-entrypoint"
    });
  });

  it("enforces supporting-section XSD cardinalities and required trigger children", () => {
    const entrypoint = stableCliPackage();
    const valid = taskXml(entrypoint);
    const withSection = (section: string) => valid.replace("<Actions", `${section}<Actions`);
    for (const invalidTrigger of [
      "<EventTrigger/>",
      "<SessionStateChangeTrigger/>",
      "<CalendarTrigger/>"
    ]) {
      expect(inspectScheduledTaskArtifact(
        withSection(`<Triggers>${invalidTrigger}</Triggers>`),
        []
      )).toMatchObject({ state: "invalid" });
    }

    const trigger = "<LogonTrigger><Enabled>true</Enabled></LogonTrigger>";
    expect(inspectScheduledTaskArtifact(
      withSection(`<Triggers>${trigger.repeat(48)}</Triggers>`),
      []
    )).toMatchObject({ state: "valid" });
    expect(inspectScheduledTaskArtifact(
      withSection(`<Triggers>${trigger.repeat(49)}</Triggers>`),
      []
    )).toMatchObject({ state: "invalid" });

    const principal = (index: number) =>
      `<Principal id="p${index.toString()}"><UserId>user-${index.toString()}</UserId></Principal>`;
    const principals = (count: number) =>
      `<Principals>${Array.from({ length: count }, (_, index) => principal(index)).join("")}</Principals>`;
    expect(inspectScheduledTaskArtifact(withSection(principals(32)), [])).toMatchObject({ state: "valid" });
    expect(inspectScheduledTaskArtifact(withSection(principals(33)), [])).toMatchObject({ state: "invalid" });
  });
});
