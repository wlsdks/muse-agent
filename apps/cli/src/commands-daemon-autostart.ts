import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { validateStableMuseCliEntry, validateStableMuseRuntimeExecutable } from "@muse/runtime-state";
import { XMLParser, XMLValidator } from "fast-xml-parser";

import { parseLaunchctlListInfo } from "./commands-daemon-launchagent.js";

const TASK_SCHEDULER_NAMESPACE = "http://schemas.microsoft.com/windows/2004/02/mit/task";
const TASK_SCHEDULER_ROOT_ELEMENTS = new Set([
  "Actions",
  "Data",
  "Principals",
  "RegistrationInfo",
  "Settings",
  "Triggers"
]);

export interface CommandProbeResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ScheduledTaskProbeResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type DaemonRuntimeStatus =
  | { readonly state: "not-registered" }
  | { readonly state: "registered-not-running" }
  | { readonly state: "crash-looping"; readonly lastExitStatus: number }
  | { readonly state: "running"; readonly pid: number }
  | { readonly state: "unknown"; readonly reason: string };

export type LaunchAgentArtifactStatus =
  | { readonly state: "missing" }
  | { readonly state: "invalid"; readonly reason: string }
  | { readonly state: "stale-entrypoint"; readonly entrypoint?: string; readonly reason: string }
  | { readonly state: "valid"; readonly entrypoint: string };

export type ScheduledTaskArtifactStatus =
  | LaunchAgentArtifactStatus
  | { readonly state: "unknown"; readonly reason: string };

export type DaemonAutostartStatus =
  | {
      readonly kind: "darwin";
      readonly plistFile: string;
      readonly artifact: LaunchAgentArtifactStatus;
      readonly runtime: DaemonRuntimeStatus;
    }
  | {
      readonly kind: "win32";
      readonly taskName: string;
      readonly artifact: ScheduledTaskArtifactStatus;
      readonly registration: "registered" | "not-registered" | "unknown";
      readonly runtime: { readonly state: "unknown"; readonly reason: string };
    }
  | {
      readonly kind: "unmanaged";
      readonly platform: NodeJS.Platform;
      readonly runtime: { readonly state: "unknown"; readonly reason: string };
    };

export interface InspectDaemonAutostartOptions {
  readonly platform: NodeJS.Platform;
  readonly plistFile: string;
  readonly launchAgentLabel: string;
  readonly scheduledTaskName: string;
  readonly runLaunchctl?: (args: readonly string[]) => Promise<CommandProbeResult>;
  readonly schtasksRun?: (args: readonly string[]) => Promise<ScheduledTaskProbeResult>;
  readonly schtasksQueryArgs: (taskName: string) => readonly string[];
  readonly temporaryRoots?: readonly string[];
}

function xmlText(value: string): string | undefined {
  if (value.includes("<")) return undefined;
  if (value.replace(/&(amp|lt|gt|quot|apos);/gu, "").includes("&")) return undefined;
  return value.replace(/&(amp|lt|gt|quot|apos);/gu, (_entity, name: string) => {
    switch (name) {
      case "amp": return "&";
      case "lt": return "<";
      case "gt": return ">";
      case "quot": return "\"";
      case "apos": return "'";
      default: return "";
    }
  });
}

/**
 * Parse the narrow EnvironmentVariables dictionary emitted by
 * {@link buildLaunchAgentPlist}. Missing means a valid empty dictionary;
 * malformed XML, duplicate dictionaries/keys, or non-string values are
 * rejected as `undefined` so a qualification probe cannot invent defaults.
 */
export function parseLaunchAgentEnvironmentVariables(plist: string): Readonly<Record<string, string>> | undefined {
  const keyPattern = /<key>\s*EnvironmentVariables\s*<\/key>/gu;
  const keyCount = [...plist.matchAll(keyPattern)].length;
  if (keyCount === 0) return {};
  if (keyCount !== 1) return undefined;

  const dictionaryPattern = /<key>\s*EnvironmentVariables\s*<\/key>\s*(?:<dict\s*\/>|<dict>([\s\S]*?)<\/dict>)/gu;
  const dictionaries = [...plist.matchAll(dictionaryPattern)];
  if (dictionaries.length !== 1) return undefined;
  const body = dictionaries[0]?.[1] ?? "";
  const pairPattern = /<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/gu;
  const variables: Record<string, string> = {};
  let cursor = 0;
  for (const match of body.matchAll(pairPattern)) {
    const index = match.index ?? 0;
    if (body.slice(cursor, index).trim().length > 0) return undefined;
    const key = xmlText(match[1] ?? "");
    const value = xmlText(match[2] ?? "");
    if (key === undefined || key.length === 0 || key.trim() !== key || value === undefined || Object.hasOwn(variables, key)) {
      return undefined;
    }
    variables[key] = value;
    cursor = index + match[0].length;
  }
  if (body.slice(cursor).trim().length > 0) return undefined;
  return variables;
}

export interface LaunchctlPrintSnapshot {
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly pid: number;
}

function launchctlBlock(
  output: string,
  label: string,
  options: { readonly required?: boolean } = {}
): readonly string[] | undefined {
  const lines = output.split(/\r?\n/u);
  const starts = lines.flatMap((line, index) => line.trim() === `${label} = {` ? [index] : []);
  if (starts.length === 0 && options.required === false) {
    return lines.some((line) => line.trim().startsWith(`${label} =`)) ? undefined : [];
  }
  if (starts.length !== 1) return undefined;
  const start = starts[0]!;
  const body: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line === "}") return body;
    if (line.endsWith("= {") || line.includes("{")) return undefined;
    if (line.length > 0) body.push(line);
  }
  return undefined;
}

function parseLaunchctlEnvironment(lines: readonly string[]): Readonly<Record<string, string>> | undefined {
  const environment: Record<string, string> = {};
  for (const line of lines) {
    const match = /^([A-Za-z_][A-Za-z\d_]*)\s*=>\s*(.*)$/u.exec(line);
    if (!match) return undefined;
    const key = match[1]!;
    if (Object.hasOwn(environment, key)) return undefined;
    environment[key] = match[2] ?? "";
  }
  return environment;
}

/**
 * Parse the live, already-loaded job state from `launchctl print`. Every
 * identity-bearing field is mandatory and unique. A service inherits manager
 * environment before its own job dictionary is applied, so all three blocks
 * are parsed conservatively with launchd precedence: inherited, then default,
 * then job-specific. Optional manager blocks may be absent; malformed or
 * duplicate blocks make the whole snapshot unverified.
 */
export function parseLaunchctlPrintSnapshot(output: string): LaunchctlPrintSnapshot | undefined {
  const argumentLines = launchctlBlock(output, "arguments");
  const inheritedEnvironmentLines = launchctlBlock(output, "inherited environment", { required: false });
  const defaultEnvironmentLines = launchctlBlock(output, "default environment", { required: false });
  const environmentLines = launchctlBlock(output, "environment");
  if (!argumentLines || argumentLines.length === 0 || !inheritedEnvironmentLines
    || !defaultEnvironmentLines || !environmentLines) return undefined;

  const inheritedEnvironment = parseLaunchctlEnvironment(inheritedEnvironmentLines);
  const defaultEnvironment = parseLaunchctlEnvironment(defaultEnvironmentLines);
  const jobEnvironment = parseLaunchctlEnvironment(environmentLines);
  if (!inheritedEnvironment || !defaultEnvironment || !jobEnvironment) return undefined;
  const environment = { ...inheritedEnvironment, ...defaultEnvironment, ...jobEnvironment };

  const pidMatches = [...output.matchAll(/^\s*pid\s*=\s*(\d+)\s*$/gmu)];
  if (pidMatches.length !== 1) return undefined;
  const pid = Number(pidMatches[0]?.[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  return { arguments: argumentLines, environment, pid };
}

/** Parse the ProgramArguments array from the narrow plist shape Muse writes. */
export function parseLaunchAgentProgramArguments(plist: string): readonly string[] | undefined {
  const keyPattern = /<key>\s*ProgramArguments\s*<\/key>/gu;
  if ([...plist.matchAll(keyPattern)].length !== 1) return undefined;
  const arrays = [...plist.matchAll(/<key>\s*ProgramArguments\s*<\/key>\s*<array>([\s\S]*?)<\/array>/gu)];
  if (arrays.length !== 1) return undefined;
  const body = arrays[0]?.[1] ?? "";
  const args: string[] = [];
  let cursor = 0;
  for (const match of body.matchAll(/<string>([\s\S]*?)<\/string>/gu)) {
    const index = match.index ?? 0;
    if (body.slice(cursor, index).trim().length > 0) return undefined;
    const value = xmlText(match[1] ?? "");
    if (value === undefined) return undefined;
    args.push(value);
    cursor = index + match[0].length;
  }
  if (body.slice(cursor).trim().length > 0 || args.length === 0) return undefined;
  return args;
}

function inspectLaunchAgentArtifact(
  plistFile: string,
  temporaryRoots: readonly string[] | undefined
): LaunchAgentArtifactStatus {
  if (!existsSync(plistFile)) return { state: "missing" };

  let programArguments: readonly string[] | undefined;
  try {
    programArguments = parseLaunchAgentProgramArguments(readFileSync(plistFile, "utf8"));
  } catch (cause) {
    return { reason: cause instanceof Error ? cause.message : "could not read plist", state: "invalid" };
  }

  if (!programArguments || programArguments.length < 2) {
    return { reason: "ProgramArguments does not contain node + Muse CLI entry", state: "invalid" };
  }

  const executable = programArguments[0] ?? "";
  const entrypoint = programArguments[1] ?? "";
  const runtimeExecutable = validateStableMuseRuntimeExecutable(executable);
  if (!runtimeExecutable.ok) {
    return { entrypoint, reason: runtimeExecutable.reason, state: "stale-entrypoint" };
  }
  const validatedEntry = validateStableMuseCliEntry(entrypoint, { temporaryRoots });
  return validatedEntry.ok
    ? { entrypoint: validatedEntry.entrypoint, state: "valid" }
    : { entrypoint, reason: validatedEntry.reason, state: "stale-entrypoint" };
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function exactlyOneRecord(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) return recordValue(value);
  return value.length === 1 ? recordValue(value[0]) : undefined;
}

function elementKeys(value: Record<string, unknown>): readonly string[] {
  return Object.keys(value).filter((key) => !key.startsWith("@_")).sort();
}

function hasOnlyAttributes(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).filter((key) => key.startsWith("@_")).every((key) => allowedSet.has(key));
}

function containsNestedNamespaceDeclaration(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => containsNestedNamespaceDeclaration(item));
  const record = recordValue(value);
  if (!record) return false;
  return Object.entries(record).some(([key, child]) =>
    key === "@_xmlns"
    || key.startsWith("@_xmlns:")
    || (!key.startsWith("@_") && containsNestedNamespaceDeclaration(child))
  );
}

interface ScheduledTaskXmlShape {
  readonly attributes?: readonly string[];
  readonly children?: Readonly<Record<string, ScheduledTaskXmlShape | "text">>;
  readonly exactlyOneOf?: readonly (readonly string[])[];
  readonly maxChildren?: number;
  readonly maxOccurrences?: Readonly<Record<string, number>>;
  readonly repeatable?: readonly string[];
  readonly required?: readonly string[];
}

const TEXT_XML_SHAPE = "text" as const;
const EMPTY_XML_SHAPE: ScheduledTaskXmlShape = {};
const REPETITION_XML_SHAPE: ScheduledTaskXmlShape = {
  children: {
    Duration: TEXT_XML_SHAPE,
    Interval: TEXT_XML_SHAPE,
    StopAtDurationEnd: TEXT_XML_SHAPE
  },
  required: ["Interval"]
};
const TRIGGER_BASE_CHILDREN = {
  Enabled: TEXT_XML_SHAPE,
  EndBoundary: TEXT_XML_SHAPE,
  ExecutionTimeLimit: TEXT_XML_SHAPE,
  Repetition: REPETITION_XML_SHAPE,
  StartBoundary: TEXT_XML_SHAPE
} as const;

function matchesScheduledTaskXmlShape(value: unknown, shape: ScheduledTaskXmlShape): boolean {
  const record = value === "" ? {} : exactlyOneRecord(value);
  if (record === undefined || !hasOnlyAttributes(record, shape.attributes ?? [])) return false;
  const allowedChildren = shape.children ?? {};
  const repeatable = new Set(shape.repeatable ?? []);
  const keys = elementKeys(record);
  if (keys.some((key) => !(key in allowedChildren))
    || (shape.required ?? []).some((key) => !keys.includes(key))
    || (shape.exactlyOneOf ?? []).some((group) => group.filter((key) => keys.includes(key)).length !== 1)) return false;
  const childCount = keys.reduce(
    (count, key) => count + (Array.isArray(record[key]) ? (record[key] as unknown[]).length : 1),
    0
  );
  if (shape.maxChildren !== undefined && childCount > shape.maxChildren) return false;
  return keys.every((key) => {
    const childShape = allowedChildren[key];
    const rawChildren = Array.isArray(record[key]) ? record[key] as unknown[] : [record[key]];
    const maximum = shape.maxOccurrences?.[key];
    if ((rawChildren.length > 1 && !repeatable.has(key))
      || (maximum !== undefined && rawChildren.length > maximum)) return false;
    return rawChildren.every((child) =>
      childShape === TEXT_XML_SHAPE
        ? typeof child === "string"
        : childShape !== undefined && matchesScheduledTaskXmlShape(child, childShape)
    );
  });
}

const REGISTRATION_INFO_XML_SHAPE: ScheduledTaskXmlShape = {
  children: Object.fromEntries([
    "Author", "Date", "Description", "Documentation", "SecurityDescriptor", "Source", "URI", "Version"
  ].map((key) => [key, TEXT_XML_SHAPE]))
};
const SETTINGS_XML_SHAPE: ScheduledTaskXmlShape = {
  children: {
    AllowHardTerminate: TEXT_XML_SHAPE,
    AllowStartOnDemand: TEXT_XML_SHAPE,
    DeleteExpiredTaskAfter: TEXT_XML_SHAPE,
    DisallowStartIfOnBatteries: TEXT_XML_SHAPE,
    DisallowStartOnRemoteAppSession: TEXT_XML_SHAPE,
    Enabled: TEXT_XML_SHAPE,
    ExecutionTimeLimit: TEXT_XML_SHAPE,
    Hidden: TEXT_XML_SHAPE,
    IdleSettings: {
      children: {
        Duration: TEXT_XML_SHAPE,
        RestartOnIdle: TEXT_XML_SHAPE,
        StopOnIdleEnd: TEXT_XML_SHAPE,
        WaitTimeout: TEXT_XML_SHAPE
      }
    },
    MultipleInstancesPolicy: TEXT_XML_SHAPE,
    NetworkProfileName: TEXT_XML_SHAPE,
    NetworkSettings: { children: { Id: TEXT_XML_SHAPE, Name: TEXT_XML_SHAPE } },
    Priority: TEXT_XML_SHAPE,
    RestartOnFailure: {
      children: { Count: TEXT_XML_SHAPE, Interval: TEXT_XML_SHAPE },
      required: ["Count", "Interval"]
    },
    RunOnlyIfIdle: TEXT_XML_SHAPE,
    RunOnlyIfNetworkAvailable: TEXT_XML_SHAPE,
    StartWhenAvailable: TEXT_XML_SHAPE,
    StopIfGoingOnBatteries: TEXT_XML_SHAPE,
    UseUnifiedSchedulingEngine: TEXT_XML_SHAPE,
    WakeToRun: TEXT_XML_SHAPE
  }
};
const PRINCIPALS_XML_SHAPE: ScheduledTaskXmlShape = {
  children: {
    Principal: {
      attributes: ["@_id"],
      children: {
        DisplayName: TEXT_XML_SHAPE,
        GroupId: TEXT_XML_SHAPE,
        LogonType: TEXT_XML_SHAPE,
        ProcessTokenSidType: TEXT_XML_SHAPE,
        RequiredPrivileges: {
          children: { Privilege: TEXT_XML_SHAPE },
          maxOccurrences: { Privilege: 64 },
          repeatable: ["Privilege"],
          required: ["Privilege"]
        },
        RunLevel: TEXT_XML_SHAPE,
        UserId: TEXT_XML_SHAPE
      }
    }
  },
  maxOccurrences: { Principal: 32 },
  repeatable: ["Principal"],
  required: ["Principal"]
};
const TRIGGERS_XML_SHAPE: ScheduledTaskXmlShape = {
  children: {
    BootTrigger: { attributes: ["@_id"], children: { ...TRIGGER_BASE_CHILDREN, Delay: TEXT_XML_SHAPE } },
    CalendarTrigger: {
      attributes: ["@_id"],
      children: {
        ...TRIGGER_BASE_CHILDREN,
        RandomDelay: TEXT_XML_SHAPE,
        ScheduleByDay: { children: { DaysInterval: TEXT_XML_SHAPE } },
        ScheduleByMonth: {
          children: {
            DaysOfMonth: {
              children: { Day: TEXT_XML_SHAPE },
              maxOccurrences: { Day: 32 },
              repeatable: ["Day"]
            },
            Months: {
              children: Object.fromEntries([
                "April", "August", "December", "February", "January", "July", "June",
                "March", "May", "November", "October", "September"
              ].map((key) => [key, EMPTY_XML_SHAPE]))
            }
          }
        },
        ScheduleByMonthDayOfWeek: {
          children: {
            DaysOfWeek: {
              children: Object.fromEntries([
                "Friday", "Monday", "Saturday", "Sunday", "Thursday", "Tuesday", "Wednesday"
              ].map((key) => [key, EMPTY_XML_SHAPE]))
            },
            Months: {
              children: Object.fromEntries([
                "April", "August", "December", "February", "January", "July", "June",
                "March", "May", "November", "October", "September"
              ].map((key) => [key, EMPTY_XML_SHAPE]))
            },
            Weeks: {
              children: { Week: TEXT_XML_SHAPE },
              maxOccurrences: { Week: 5 },
              repeatable: ["Week"]
            }
          }
        },
        ScheduleByWeek: {
          children: {
            DaysOfWeek: {
              children: Object.fromEntries([
                "Friday", "Monday", "Saturday", "Sunday", "Thursday", "Tuesday", "Wednesday"
              ].map((key) => [key, EMPTY_XML_SHAPE]))
            },
            WeeksInterval: TEXT_XML_SHAPE
          }
        }
      },
      exactlyOneOf: [[
        "ScheduleByDay", "ScheduleByMonth", "ScheduleByMonthDayOfWeek", "ScheduleByWeek"
      ]]
    },
    EventTrigger: {
      attributes: ["@_id"],
      children: {
        ...TRIGGER_BASE_CHILDREN,
        Delay: TEXT_XML_SHAPE,
        MatchingElement: TEXT_XML_SHAPE,
        NumberOfOccurrences: TEXT_XML_SHAPE,
        PeriodOfOccurrence: TEXT_XML_SHAPE,
        Subscription: TEXT_XML_SHAPE,
        ValueQueries: {
          children: { Value: { attributes: ["@_name"], children: { "#text": TEXT_XML_SHAPE } } },
          maxOccurrences: { Value: 32 },
          repeatable: ["Value"],
          required: ["Value"]
        }
      },
      required: ["Subscription"]
    },
    IdleTrigger: { attributes: ["@_id"], children: TRIGGER_BASE_CHILDREN },
    LogonTrigger: {
      attributes: ["@_id"],
      children: { ...TRIGGER_BASE_CHILDREN, Delay: TEXT_XML_SHAPE, UserId: TEXT_XML_SHAPE }
    },
    RegistrationTrigger: { attributes: ["@_id"], children: { ...TRIGGER_BASE_CHILDREN, Delay: TEXT_XML_SHAPE } },
    SessionStateChangeTrigger: {
      attributes: ["@_id"],
      children: {
        ...TRIGGER_BASE_CHILDREN,
        Delay: TEXT_XML_SHAPE,
        StateChange: TEXT_XML_SHAPE,
        UserId: TEXT_XML_SHAPE
      },
      required: ["StateChange"]
    },
    TimeTrigger: { attributes: ["@_id"], children: { ...TRIGGER_BASE_CHILDREN, RandomDelay: TEXT_XML_SHAPE } }
  },
  maxChildren: 48,
  repeatable: [
    "BootTrigger", "CalendarTrigger", "EventTrigger", "IdleTrigger", "LogonTrigger",
    "RegistrationTrigger", "SessionStateChangeTrigger", "TimeTrigger"
  ]
};

function hasStrictScheduledTaskSupportingSections(task: Record<string, unknown>): boolean {
  return (task.RegistrationInfo === undefined
      || matchesScheduledTaskXmlShape(task.RegistrationInfo, REGISTRATION_INFO_XML_SHAPE))
    && (task.Settings === undefined || matchesScheduledTaskXmlShape(task.Settings, SETTINGS_XML_SHAPE))
    && (task.Principals === undefined || matchesScheduledTaskXmlShape(task.Principals, PRINCIPALS_XML_SHAPE))
    && (task.Triggers === undefined || matchesScheduledTaskXmlShape(task.Triggers, TRIGGERS_XML_SHAPE))
    && (task.Data === undefined || typeof task.Data === "string");
}

/** Parse only the exact two arguments Muse persists: CLI entry + `daemon`. */
function parseScheduledTaskArguments(raw: string): readonly [string, "daemon"] | undefined {
  const match = /^(?:"([^"]+)"|(\S+))\s+daemon$/u.exec(raw.trim());
  const entrypoint = match?.[1] ?? match?.[2];
  return entrypoint ? [entrypoint, "daemon"] : undefined;
}

export function inspectScheduledTaskArtifact(
  taskXml: string,
  temporaryRoots: readonly string[] | undefined
): ScheduledTaskArtifactStatus {
  if (/<!DOCTYPE|<!ENTITY/iu.test(taskXml)
    || XMLValidator.validate(taskXml, { allowBooleanAttributes: false }) !== true) {
    return { reason: "scheduled task XML is malformed or contains declarations", state: "invalid" };
  }
  let document: Record<string, unknown>;
  try {
    document = new XMLParser({
      attributeNamePrefix: "@_",
      ignoreAttributes: false,
      parseTagValue: false,
      trimValues: true
    }).parse(taskXml) as Record<string, unknown>;
  } catch {
    return { reason: "scheduled task XML cannot be parsed", state: "invalid" };
  }
  const documentKeys = Object.keys(document);
  const declaration = document["?xml"];
  const declarationRecord = declaration === undefined ? undefined : exactlyOneRecord(declaration);
  if (documentKeys.some((key) => key !== "?xml" && key !== "Task")
    || documentKeys.filter((key) => key === "Task").length !== 1
    || (declaration !== undefined
      && (declarationRecord === undefined
        || !hasOnlyAttributes(declarationRecord, ["@_encoding", "@_standalone", "@_version"])
        || elementKeys(declarationRecord).length !== 0))) {
    return { reason: "scheduled task XML must contain exactly one top-level Task", state: "invalid" };
  }
  const task = exactlyOneRecord(document.Task);
  const taskElements = task === undefined ? [] : elementKeys(task);
  if (task === undefined
    || task["@_xmlns"] !== TASK_SCHEDULER_NAMESPACE
    || !hasOnlyAttributes(task, ["@_version", "@_xmlns"])
    || !taskElements.includes("Actions")
    || taskElements.some((key) => !TASK_SCHEDULER_ROOT_ELEMENTS.has(key))
    || taskElements.some((key) => Array.isArray(task[key]))
    || taskElements.some((key) => containsNestedNamespaceDeclaration(task[key]))
    || !hasStrictScheduledTaskSupportingSections(task)) {
    return { reason: "scheduled task XML does not use the expected Task Scheduler namespace", state: "invalid" };
  }
  const actions = task === undefined ? undefined : exactlyOneRecord(task.Actions);
  if (actions === undefined
    || elementKeys(actions).join(",") !== "Exec"
    || !hasOnlyAttributes(actions, ["@_Context"])) {
    return { reason: "scheduled task XML does not contain exactly one Exec action", state: "invalid" };
  }
  const exec = exactlyOneRecord(actions.Exec);
  const execKeys = exec === undefined ? [] : elementKeys(exec);
  if (exec === undefined
    || !execKeys.includes("Command")
    || !execKeys.includes("Arguments")
    || execKeys.some((key) => key !== "Arguments" && key !== "Command")
    || !hasOnlyAttributes(exec, [])
  ) {
    return { reason: "scheduled task XML does not contain exactly one Exec action", state: "invalid" };
  }
  const executable = typeof exec.Command === "string" ? exec.Command.trim() : undefined;
  const argumentsText = typeof exec.Arguments === "string" ? exec.Arguments.trim() : undefined;
  const arguments_ = argumentsText === undefined ? undefined : parseScheduledTaskArguments(argumentsText);
  if (!executable || !arguments_) {
    return { reason: "scheduled task Exec does not contain node + Muse CLI entry + daemon", state: "invalid" };
  }
  const runtimeExecutable = validateStableMuseRuntimeExecutable(executable);
  if (!runtimeExecutable.ok) {
    return {
      entrypoint: arguments_[0],
      reason: runtimeExecutable.reason,
      state: "stale-entrypoint"
    };
  }
  const validatedEntry = validateStableMuseCliEntry(arguments_[0], { temporaryRoots });
  return validatedEntry.ok
    ? { entrypoint: validatedEntry.entrypoint, state: "valid" }
    : { entrypoint: arguments_[0], reason: validatedEntry.reason, state: "stale-entrypoint" };
}

export async function inspectDaemonAutostart(options: InspectDaemonAutostartOptions): Promise<DaemonAutostartStatus> {
  if (options.platform === "win32") {
    if (!options.schtasksRun) {
      return {
        artifact: { reason: "Task Scheduler probe unavailable", state: "unknown" },
        kind: "win32",
        registration: "unknown",
        runtime: { reason: "Task Scheduler probe unavailable", state: "unknown" },
        taskName: options.scheduledTaskName
      };
    }
    const query = await options.schtasksRun(options.schtasksQueryArgs(options.scheduledTaskName));
    if (query.exitCode !== 0) {
      const output = `${query.stderr}\n${query.stdout}`.trim();
      const missing = output === "ERROR: The system cannot find the file specified.";
      return {
        artifact: missing
          ? { state: "missing" }
          : { reason: `Task Scheduler query failed (exit ${query.exitCode.toString()}): ${output || "no diagnostic output"}`, state: "unknown" },
        kind: "win32",
        registration: missing ? "not-registered" : "unknown",
        runtime: { reason: "Task Scheduler registration does not prove a resident process is running", state: "unknown" },
        taskName: options.scheduledTaskName
      };
    }
    return {
      artifact: inspectScheduledTaskArtifact(query.stdout, options.temporaryRoots),
      kind: "win32",
      registration: "registered",
      runtime: { reason: "Task Scheduler registration does not prove a resident process is running", state: "unknown" },
      taskName: options.scheduledTaskName
    };
  }

  if (options.platform !== "darwin") {
    return {
      kind: "unmanaged",
      platform: options.platform,
      runtime: { reason: "Muse does not manage autostart on this platform", state: "unknown" }
    };
  }

  const artifact = inspectLaunchAgentArtifact(options.plistFile, options.temporaryRoots);
  if (!options.runLaunchctl) {
    return {
      artifact,
      kind: "darwin",
      plistFile: options.plistFile,
      runtime: { reason: "launchctl probe unavailable", state: "unknown" }
    };
  }

  const query = await options.runLaunchctl(["list", options.launchAgentLabel]);
  if (query.code !== 0) {
    const output = `${query.stderr}\n${query.stdout}`.trim();
    if (/could not find|not found|no such (?:process|service)/iu.test(output)) {
      return { artifact, kind: "darwin", plistFile: options.plistFile, runtime: { state: "not-registered" } };
    }
    return {
      artifact,
      kind: "darwin",
      plistFile: options.plistFile,
      runtime: {
        reason: `launchctl list failed (exit ${query.code.toString()}): ${output || "no diagnostic output"}`,
        state: "unknown"
      }
    };
  }

  const { pid, lastExitStatus } = parseLaunchctlListInfo(query.stdout);
  if (pid !== undefined) {
    return { artifact, kind: "darwin", plistFile: options.plistFile, runtime: { pid, state: "running" } };
  }
  if (lastExitStatus !== undefined && lastExitStatus !== 0) {
    return {
      artifact,
      kind: "darwin",
      plistFile: options.plistFile,
      runtime: { lastExitStatus, state: "crash-looping" }
    };
  }
  return { artifact, kind: "darwin", plistFile: options.plistFile, runtime: { state: "registered-not-running" } };
}

export function isDaemonAutostartHealthy(status: DaemonAutostartStatus): boolean {
  return status.kind === "darwin" && status.artifact.state === "valid" && status.runtime.state === "running";
}

function describeArtifact(artifact: ScheduledTaskArtifactStatus): string {
  switch (artifact.state) {
    case "missing": return "missing";
    case "unknown": return `unknown (${artifact.reason})`;
    case "valid": return "valid";
    case "invalid": return `invalid (${artifact.reason})`;
    case "stale-entrypoint": return `stale entrypoint (${artifact.reason})`;
  }
}

function describeRuntime(runtime: DaemonRuntimeStatus): string {
  switch (runtime.state) {
    case "not-registered": return "not registered";
    case "registered-not-running": return "registered but not running";
    case "crash-looping": return `crash-looping (last exit status ${runtime.lastExitStatus.toString()})`;
    case "running": return `running (pid ${runtime.pid.toString()})`;
    case "unknown": return `unknown (${runtime.reason})`;
  }
}

export function formatDaemonAutostartStatus(status: DaemonAutostartStatus): readonly string[] {
  if (status.kind === "darwin") {
    return [
      `autostart:    ${isDaemonAutostartHealthy(status) ? "healthy" : "not ready"} (${status.plistFile})`,
      `  artifact:     ${describeArtifact(status.artifact)}`,
      `  runtime:      ${describeRuntime(status.runtime)}`
    ];
  }
  if (status.kind === "win32") {
    const registration = status.registration === "not-registered" ? "not registered" : status.registration;
    return [
      `autostart:    ${registration} (scheduled task ${status.taskName})`,
      `  artifact:     ${describeArtifact(status.artifact)}`,
      `  runtime:      unknown (${status.runtime.reason})`
    ];
  }
  return [
    `autostart:    unmanaged on ${status.platform}`,
    `  runtime:      unknown (${status.runtime.reason})`
  ];
}

export function describeDaemonAutostartForDoctor(status: DaemonAutostartStatus): string {
  if (status.kind === "darwin") {
    const base = `LaunchAgent artifact ${describeArtifact(status.artifact)}; runtime ${describeRuntime(status.runtime)}`;
    if (isDaemonAutostartHealthy(status)) return base;
    if (status.artifact.state === "missing" || status.runtime.state === "not-registered") {
      return `${base} — run \`muse daemon --install\``;
    }
    return `${base} — inspect \`muse daemon --status\`, then reinstall if needed`;
  }
  if (status.kind === "win32") {
    const registration = status.registration === "not-registered" ? "not registered" : status.registration;
    return `scheduled task ${registration}; artifact ${describeArtifact(status.artifact)}; runtime unknown — inspect Task Scheduler before trusting idle learning`;
  }
  return `autostart unmanaged on ${status.platform}; runtime unknown — keep \`muse daemon\` resident with your service manager`;
}

export interface ValidateDaemonCliEntryOptions {
  readonly temporaryRoots?: readonly string[];
}

export type DaemonCliEntryValidation =
  | { readonly ok: true; readonly entrypoint: string }
  | { readonly ok: false; readonly reason: string };

export function defaultDaemonTemporaryRoots(env: NodeJS.ProcessEnv): readonly string[] {
  return [...new Set([
    tmpdir(),
    env.TMPDIR,
    env.TMP,
    env.TEMP,
    ...(process.platform === "darwin" ? ["/tmp", "/private/tmp", "/var/tmp"] : [])
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => resolve(value)))];
}

export function validateDaemonCliEntry(
  rawEntry: string | undefined,
  options: ValidateDaemonCliEntryOptions = {}
): DaemonCliEntryValidation {
  const temporaryRoots = options.temporaryRoots ?? defaultDaemonTemporaryRoots(process.env);
  return validateStableMuseCliEntry(rawEntry, { temporaryRoots });
}
