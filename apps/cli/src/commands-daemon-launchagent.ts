/**
 * macOS LaunchAgent (launchd) wiring for the resident `muse daemon`: the plist
 * builder + its install path. Split out of commands-daemon.ts; pure string/path
 * helpers, no daemon runtime state.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { XMLParser, XMLValidator } from "fast-xml-parser";

export const LAUNCH_AGENT_LABEL = "com.muse.daemon";

type OrderedXmlNode = Readonly<Record<string, unknown>>;

function orderedXmlNode(value: unknown): OrderedXmlNode | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as OrderedXmlNode
    : undefined;
}

function orderedXmlChildren(node: OrderedXmlNode, name: string): readonly unknown[] | undefined {
  const value = node[name];
  return Array.isArray(value) ? value : undefined;
}

function orderedXmlElementChildren(node: OrderedXmlNode, name: string): readonly unknown[] | undefined {
  const children = orderedXmlChildren(node, name);
  return children?.filter((child) => {
    const record = orderedXmlNode(child);
    return !(record
      && Object.keys(record).join(",") === "#text"
      && typeof record["#text"] === "string"
      && record["#text"].trim().length === 0);
  });
}

function orderedXmlText(node: unknown, name: string): string | undefined {
  const record = orderedXmlNode(node);
  if (!record || Object.keys(record).some((key) => key !== name)) return undefined;
  const children = orderedXmlChildren(record, name);
  if (!children || children.length !== 1) return undefined;
  const text = orderedXmlNode(children[0]);
  if (!text || Object.keys(text).join(",") !== "#text" || typeof text["#text"] !== "string") {
    return undefined;
  }
  return text["#text"];
}

/**
 * Read the identity-bearing Label from the narrow plist structure launchd
 * consumes. Preserve element order so a key is bound only to its following
 * value; comments, duplicate Label keys, attributes on Label values, malformed
 * XML, and extra top-level documents all fail closed.
 */
export function parseLaunchAgentLabel(plist: string): string | undefined {
  if (/<!ENTITY/iu.test(plist)
    || XMLValidator.validate(plist, { allowBooleanAttributes: false }) !== true) {
    return undefined;
  }

  let document: unknown;
  try {
    document = new XMLParser({
      attributeNamePrefix: "@_",
      ignoreAttributes: false,
      parseTagValue: false,
      preserveOrder: true,
      trimValues: false
    }).parse(plist);
  } catch {
    return undefined;
  }
  if (!Array.isArray(document)) return undefined;

  const roots = document.filter((item) => {
    const node = orderedXmlNode(item);
    return node !== undefined && Object.hasOwn(node, "plist");
  });
  if (roots.length !== 1) return undefined;
  const root = orderedXmlNode(roots[0]);
  if (!root || Object.keys(root).some((key) => key !== "plist" && key !== ":@")) return undefined;
  const rootAttributes = orderedXmlNode(root[":@"]);
  if (rootAttributes
    && (Object.keys(rootAttributes).join(",") !== "@_version" || rootAttributes["@_version"] !== "1.0")) {
    return undefined;
  }
  const plistChildren = orderedXmlElementChildren(root, "plist");
  if (!plistChildren || plistChildren.length !== 1) return undefined;
  const dictionary = orderedXmlNode(plistChildren[0]);
  if (!dictionary || Object.keys(dictionary).join(",") !== "dict") return undefined;
  const entries = orderedXmlElementChildren(dictionary, "dict");
  if (!entries) return undefined;

  let label: string | undefined;
  for (let index = 0; index < entries.length; index += 1) {
    if (orderedXmlText(entries[index], "key") !== "Label") continue;
    if (label !== undefined) return undefined;
    label = orderedXmlText(entries[index + 1], "string");
    if (label === undefined) return undefined;
  }
  return label;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// A macOS LaunchAgent plist that keeps `muse daemon` resident: it
// starts at login (RunAtLoad) and is restarted if it exits
// (KeepAlive), so the daemon survives logout / reboot. ProcessType
// Background marks it low-priority so macOS throttles its CPU/IO under
// contention — the OS-level complement to the brake-first idle gates
// (B1): background learning must never compete with the user's work.
export function buildLaunchAgentPlist(opts: {
  readonly label: string;
  readonly programArguments: readonly string[];
  readonly environmentVariables?: Readonly<Record<string, string>>;
  readonly stdoutPath: string;
  readonly stderrPath: string;
}): string {
  const args = opts.programArguments
    .map((arg) => `    <string>${xmlEscape(arg)}</string>`)
    .join("\n");
  const environmentEntries = Object.entries(opts.environmentVariables ?? {})
    .sort(([left], [right]) => left.localeCompare(right));
  const environment = environmentEntries.length === 0
    ? ""
    : `  <key>EnvironmentVariables</key>
  <dict>
${environmentEntries
    .map(([key, value]) => `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`)
    .join("\n")}
  </dict>
`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(opts.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
${environment}  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(opts.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(opts.stderrPath)}</string>
</dict>
</plist>
`;
}

export function resolveLaunchAgentFile(env: NodeJS.ProcessEnv): string {
  const explicit = env.MUSE_DAEMON_PLIST_FILE?.trim();
  if (explicit && explicit.length > 0) return explicit;
  const home = env.HOME?.trim()?.length ? env.HOME.trim() : homedir();
  return join(home, "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
}

export interface LaunchctlListInfo {
  /** Present + > 0 only when the job is RUNNING right now. */
  readonly pid?: number;
  /** Exit status of the job's most recent stop, when launchd reports one. */
  readonly lastExitStatus?: number;
}

/**
 * Parse `launchctl list <label>` output for a FOUND label. launchd prints an
 * NSDictionary-style dump (quoted keys, not JSON) — e.g. `"PID" = 1234;` and
 * `"LastExitStatus" = 0;` — never a simple exit code. A present PID means the
 * job is running now; its absence combined with a non-zero LastExitStatus
 * means launchd has the label registered but the job crashed or failed to
 * start (crash-looping) — the two states `list`'s own exit code alone can't
 * distinguish (both exit 0: registered proves nothing about actually running).
 */
export function parseLaunchctlListInfo(stdout: string): LaunchctlListInfo {
  const pidMatch = /"PID"\s*=\s*(\d+);/.exec(stdout);
  const statusMatch = /"LastExitStatus"\s*=\s*(-?\d+);/.exec(stdout);
  const pid = pidMatch ? Number(pidMatch[1]) : undefined;
  const lastExitStatus = statusMatch ? Number(statusMatch[1]) : undefined;
  return {
    ...(pid !== undefined && Number.isFinite(pid) && pid > 0 ? { pid } : {}),
    ...(lastExitStatus !== undefined && Number.isFinite(lastExitStatus) ? { lastExitStatus } : {})
  };
}
