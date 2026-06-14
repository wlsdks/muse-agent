import type { JsonObject, JsonValue } from "@muse/shared";
import type { MuseTool } from "@muse/tools";

import { defaultOsascriptRunner, escapeAppleScript, isPermissionError, NETWORKSETUP_PATH, OSASCRIPT_TIMEOUT_MS, parseWifiDevice, PMSET_PATH, runChild, type MacCommandResult, type MacOsascriptRunner } from "./macos-exec.js";

const DF_PATH = "/bin/df";
const IPCONFIG_PATH = "/usr/sbin/ipconfig";

// ── Tier 0: mac_app_read ──────────────────────────────────────────────

// osascript-backed read sources (each maps to an AppleScript snippet)…
const MAC_OSASCRIPT_READ_APPS = [
  "clipboard", "music", "frontmost_window", "contacts", "mail_unread", "safari_tab", "chrome_tab", "volume",
  "reminders", "calendar", "notes", "running_apps"
] as const;
type MacReadApp = (typeof MAC_OSASCRIPT_READ_APPS)[number];
// …plus shell-backed sources that don't go through osascript.
const MAC_SHELL_READ_APPS = ["battery", "storage", "wifi_status", "ip_address"] as const;
const MAC_APP_READ_APPS = [...MAC_OSASCRIPT_READ_APPS, ...MAC_SHELL_READ_APPS] as const;

function buildReadScript(app: MacReadApp, query: string): string {
  switch (app) {
    case "clipboard":
      return `return (the clipboard as text)`;
    case "music":
      return [
        `tell application "Music"`,
        `  if it is running then`,
        `    set st to (player state as text)`,
        `    if st is "playing" or st is "paused" then`,
        `      return st & tab & (name of current track) & tab & (artist of current track)`,
        `    else`,
        `      return st`,
        `    end if`,
        `  else`,
        `    return "stopped"`,
        `  end if`,
        `end tell`
      ].join("\n");
    case "frontmost_window":
      return [
        `tell application "System Events"`,
        `  set procName to name of first application process whose frontmost is true`,
        `  set winTitle to ""`,
        `  try`,
        `    set winTitle to name of front window of (first application process whose frontmost is true)`,
        `  end try`,
        `  return procName & tab & winTitle`,
        `end tell`
      ].join("\n");
    case "contacts":
      return [
        `set output to ""`,
        `tell application "Contacts"`,
        `  repeat with p in (people whose name contains "${escapeAppleScript(query)}")`,
        `    set pphones to ""`,
        `    repeat with ph in phones of p`,
        `      set pphones to pphones & (value of ph) & ";"`,
        `    end repeat`,
        `    set pemails to ""`,
        `    repeat with em in emails of p`,
        `      set pemails to pemails & (value of em) & ";"`,
        `    end repeat`,
        `    set output to output & (name of p) & tab & pphones & tab & pemails & linefeed`,
        `  end repeat`,
        `end tell`,
        `return output`
      ].join("\n");
    case "mail_unread":
      return [
        `tell application "Mail"`,
        `  set cnt to unread count of inbox`,
        `  set output to (cnt as text) & linefeed`,
        `  set i to 0`,
        `  repeat with m in (messages of inbox whose read status is false)`,
        `    if i is greater than or equal to 10 then exit repeat`,
        `    set output to output & (subject of m) & tab & (sender of m) & linefeed`,
        `    set i to i + 1`,
        `  end repeat`,
        `  return output`,
        `end tell`
      ].join("\n");
    case "safari_tab":
      return [
        `tell application "Safari"`,
        `  if it is running and (count of windows) > 0 then`,
        `    return (URL of current tab of front window) & tab & (name of current tab of front window)`,
        `  else`,
        `    return "not running"`,
        `  end if`,
        `end tell`
      ].join("\n");
    case "chrome_tab":
      return [
        `tell application "Google Chrome"`,
        `  if it is running and (count of windows) > 0 then`,
        `    return (URL of active tab of front window) & tab & (title of active tab of front window)`,
        `  else`,
        `    return "not running"`,
        `  end if`,
        `end tell`
      ].join("\n");
    case "volume":
      return [
        `set s to (get volume settings)`,
        `return (output volume of s as text) & tab & (output muted of s as text)`
      ].join("\n");
    case "reminders":
      return [
        `tell application "Reminders"`,
        `  set output to ""`,
        `  set allLists to every list`,
        `  repeat with rl in allLists`,
        `    set incomplete to (reminders of rl whose completed is false)`,
        `    repeat with r in incomplete`,
        `      set rName to name of r`,
        `      set rDue to ""`,
        `      try`,
        `        set rDue to (due date of r as text)`,
        `      end try`,
        `      set output to output & rName & tab & rDue & linefeed`,
        `    end repeat`,
        `  end repeat`,
        `  return output`,
        `end tell`
      ].join("\n");
    case "calendar":
      return [
        `set todayStart to current date`,
        `set hours of todayStart to 0`,
        `set minutes of todayStart to 0`,
        `set seconds of todayStart to 0`,
        `set todayEnd to todayStart + (24 * 60 * 60)`,
        `set output to ""`,
        `tell application "Calendar"`,
        `  repeat with aCal in every calendar`,
        `    set evts to (every event of aCal whose start date >= todayStart and start date < todayEnd)`,
        `    repeat with e in evts`,
        `      set eTitle to summary of e`,
        `      set eStart to (start date of e as text)`,
        `      set output to output & eTitle & tab & eStart & linefeed`,
        `    end repeat`,
        `  end repeat`,
        `end tell`,
        `return output`
      ].join("\n");
    case "notes":
      return [
        `tell application "Notes"`,
        `  set output to ""`,
        `  set noteList to every note`,
        `  set maxCount to 20`,
        `  set i to 0`,
        `  repeat with n in noteList`,
        `    if i >= maxCount then exit repeat`,
        `    set output to output & (name of n) & linefeed`,
        `    set i to i + 1`,
        `  end repeat`,
        `  return output`,
        `end tell`
      ].join("\n");
    case "running_apps":
      return [
        `tell application "System Events"`,
        `  set appNames to name of every process whose background only is false`,
        `  set output to ""`,
        `  repeat with n in appNames`,
        `    set output to output & n & ","`,
        `  end repeat`,
        `  return output`,
        `end tell`
      ].join("\n");
  }
}

function parseReadOutput(app: MacReadApp, stdout: string): JsonObject {
  const raw = stdout.replace(/\n$/u, "");
  switch (app) {
    case "clipboard":
      return { app, text: raw };
    case "music": {
      const [state = "stopped", track, artist] = raw.split("\t");
      return {
        app,
        state,
        ...(track ? { track } : {}),
        ...(artist ? { artist } : {})
      };
    }
    case "frontmost_window": {
      const [process = "", windowTitle = ""] = raw.split("\t");
      return { app, process, windowTitle };
    }
    case "contacts": {
      const people: JsonValue[] = raw
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => {
          const [name = "", phones = "", emails = ""] = line.split("\t");
          return {
            emails: emails.split(";").map((e) => e.trim()).filter(Boolean),
            name,
            phones: phones.split(";").map((p) => p.trim()).filter(Boolean)
          };
        });
      return { app, people };
    }
    case "mail_unread": {
      const lines = raw.split(/\r?\n/u);
      const unreadCount = Number.parseInt(lines[0] ?? "0", 10);
      const recent: JsonValue[] = lines.slice(1)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => {
          const [subject = "", sender = ""] = line.split("\t");
          return { sender, subject };
        });
      return { app, recent, unreadCount: Number.isFinite(unreadCount) ? unreadCount : 0 };
    }
    case "safari_tab":
    case "chrome_tab": {
      if (raw.trim() === "not running") {
        return { app, running: false };
      }
      const [url = "", title = ""] = raw.split("\t");
      return { app, running: true, title, url };
    }
    case "volume": {
      const [vol = "0", muted = "false"] = raw.split("\t");
      const outputVolume = Number.parseInt(vol, 10);
      return { app, muted: muted.trim() === "true", outputVolume: Number.isFinite(outputVolume) ? outputVolume : 0 };
    }
    case "reminders": {
      const items: JsonValue[] = raw
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line): JsonObject => {
          const [title = "", dueDate = ""] = line.split("\t");
          return dueDate.length > 0
            ? { dueDate, title }
            : { title };
        });
      return { app, count: items.length, items };
    }
    case "calendar": {
      const items: JsonValue[] = raw
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line): JsonObject => {
          const [title = "", start = ""] = line.split("\t");
          return start.length > 0
            ? { start, title }
            : { title };
        });
      return { app, count: items.length, items };
    }
    case "notes": {
      const items: JsonValue[] = raw
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line): JsonObject => ({ title: line }));
      return { app, count: items.length, items };
    }
    case "running_apps": {
      const apps = parseRunningAppsOutput(raw);
      return { app, apps, count: apps.length };
    }
  }
}

/** Parses `pmset -g batt` into percent + charging state. */
function parseBatteryOutput(stdout: string): JsonObject {
  const percentMatch = /(\d+)%/u.exec(stdout);
  const percent = percentMatch ? Number.parseInt(percentMatch[1]!, 10) : null;
  const onAc = /AC Power/iu.test(stdout);
  const stateMatch = /;\s*(charged|charging|discharging|finishing charge|AC attached)/iu.exec(stdout);
  return {
    app: "battery",
    charging: onAc,
    percent,
    ...(stateMatch ? { state: stateMatch[1]!.toLowerCase() } : {})
  };
}

/** Parses `df -h /` (header + one data row) into the boot volume's totals. */
function parseStorageOutput(stdout: string): JsonObject {
  const row = stdout.split(/\r?\n/u).map((l) => l.trim()).filter(Boolean)[1] ?? "";
  const cols = row.split(/\s+/u);
  // df -h columns: Filesystem Size Used Avail Capacity ...
  return {
    app: "storage",
    available: cols[3] ?? null,
    capacity: cols[4] ?? null,
    total: cols[1] ?? null,
    used: cols[2] ?? null
  };
}

/** Parses `networksetup -getairportnetwork <dev>` into connected + network name. */
function parseWifiStatusOutput(stdout: string): JsonObject {
  const nameMatch = /^Current Wi-Fi Network:\s*(.+)$/mu.exec(stdout.trim());
  if (nameMatch) {
    return { app: "wifi_status", connected: true, network: nameMatch[1]!.trim() };
  }
  return { app: "wifi_status", connected: false, network: null };
}

/** Parses `ipconfig getifaddr <dev>` (single-line IP or empty) into an IP string or null. */
function parseIpAddressOutput(stdout: string): string | null {
  const ip = stdout.trim();
  return ip.length > 0 ? ip : null;
}

/** Parses comma- or newline-delimited app names from System Events `running_apps` output. */
function parseRunningAppsOutput(raw: string): string[] {
  const delimiter = raw.includes(",") ? "," : "\n";
  return raw
    .split(delimiter)
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

type MacShellRead = (typeof MAC_SHELL_READ_APPS)[number];

export interface MacAppReadToolDeps {
  readonly runner?: MacOsascriptRunner;
  /** Shell runner for the non-osascript sources (`battery` → pmset, `storage` → df). */
  readonly shell?: (bin: string, args: readonly string[]) => Promise<MacCommandResult>;
}

export function createMacAppReadTool(deps: MacAppReadToolDeps = {}): MuseTool {
  const runner = deps.runner ?? defaultOsascriptRunner;
  const shell = deps.shell ?? ((bin: string, args: readonly string[]) => runChild(bin, args, undefined, 10_000));
  return {
    definition: {
      description:
        "Read the CURRENT state of the Mac — read-only, changes nothing. `app` selects what to read: " +
        "'clipboard' (clipboard text), 'music' (what Music is playing), 'frontmost_window' (the app + " +
        "window in focus), 'contacts' (look up a person by name — requires `query`), 'mail_unread' (inbox " +
        "unread count + recent subjects), 'safari_tab' / 'chrome_tab' (front browser tab URL + title), " +
        "'volume' (output volume + muted), 'battery' (charge % + charging), 'storage' (disk space free/" +
        "used), 'wifi_status' (whether Wi-Fi is connected and the current network name), " +
        "'ip_address' (the current Wi-Fi IP address, or null if not connected), " +
        "'reminders' (all incomplete reminders with optional due dates), " +
        "'calendar' (today's events from Calendar.app with start times), " +
        "'notes' (recent note titles from Notes.app, up to 20), " +
        "'running_apps' (names of all currently running foreground apps). " +
        "Use when the user asks what's on the clipboard, what song is playing, what page/tab " +
        "they're on, the volume / battery / free disk space, a contact's phone/email, unread mail, " +
        "what reminders / to-dos are pending, what's on their calendar today, what notes they have, " +
        "what's their IP address, what apps are open / running right now, " +
        "or whether they are on Wi-Fi and which network. " +
        "Do NOT use it to send or change anything (mac_message_send / mac_media_control / mac_system_set). " +
        "Do NOT use it to ADD a reminder (use muse.reminders.add). " +
        "Do NOT use it to turn Wi-Fi on/off (use mac_system_set). " +
        "Do NOT use it to create calendar events or notes.",
      domain: "system",
      inputSchema: {
        additionalProperties: false,
        properties: {
          app: {
            description: "Which state to read, e.g. 'battery' or 'storage'.",
            enum: [...MAC_APP_READ_APPS],
            type: "string"
          },
          query: {
            description: "Name to look up — REQUIRED only when app is 'contacts', e.g. 'Jane'. Ignored otherwise.",
            type: "string"
          }
        },
        required: ["app"],
        type: "object"
      },
      keywords: [
        "clipboard", "클립보드", "music", "playing", "song", "노래", "음악",
        "contact", "연락처", "phone", "email", "window", "frontmost", "mail", "unread", "메일", "안읽은",
        "battery", "배터리", "volume", "볼륨", "tab", "탭", "safari", "사파리", "chrome", "크롬", "browser",
        "storage", "disk", "디스크", "저장공간", "용량",
        "wifi", "wi-fi", "와이파이", "network", "네트워크", "connected", "연결",
        "ip", "ip address", "아이피", "주소", "ip 주소",
        "reminder", "reminders", "리마인더", "할일", "todo", "to-do", "pending",
        "calendar", "캘린더", "일정", "schedule", "event", "오늘 일정", "today",
        "notes", "노트", "메모", "note titles",
        "running apps", "open apps", "실행 중인 앱", "실행중인 앱", "앱 목록", "running", "open applications"
      ],
      name: "mac_app_read",
      risk: "read"
    },
    execute: async (args): Promise<JsonObject> => {
      const app = typeof args["app"] === "string" ? args["app"].trim() : "";
      if (!MAC_APP_READ_APPS.includes(app as (typeof MAC_APP_READ_APPS)[number])) {
        return { error: `app must be one of: ${MAC_APP_READ_APPS.join(", ")}` };
      }
      if (MAC_SHELL_READ_APPS.includes(app as MacShellRead)) {
        if (app === "wifi_status") {
          let ports: MacCommandResult;
          try {
            ports = await shell(NETWORKSETUP_PATH, ["-listallhardwareports"]);
          } catch (cause) {
            return { error: `wifi_status read spawn failed: ${cause instanceof Error ? cause.message : String(cause)}` };
          }
          if (ports.timedOut || ports.exitCode !== 0) {
            return { error: `wifi_status read failed: ${ports.stderr.trim().slice(0, 200) || "timed out"}` };
          }
          const device = parseWifiDevice(ports.stdout);
          if (!device) {
            return { app: "wifi_status", connected: false, network: null };
          }
          let status: MacCommandResult;
          try {
            status = await shell(NETWORKSETUP_PATH, ["-getairportnetwork", device]);
          } catch (cause) {
            return { error: `wifi_status read spawn failed: ${cause instanceof Error ? cause.message : String(cause)}` };
          }
          if (status.timedOut || status.exitCode !== 0) {
            return { error: `wifi_status read failed: ${status.stderr.trim().slice(0, 200) || "timed out"}` };
          }
          return parseWifiStatusOutput(status.stdout);
        }
        if (app === "ip_address") {
          let ports: MacCommandResult;
          try {
            ports = await shell(NETWORKSETUP_PATH, ["-listallhardwareports"]);
          } catch (cause) {
            return { error: `ip_address read spawn failed: ${cause instanceof Error ? cause.message : String(cause)}` };
          }
          if (ports.timedOut || ports.exitCode !== 0) {
            return { error: `ip_address read failed: ${ports.stderr.trim().slice(0, 200) || "timed out"}` };
          }
          const device = parseWifiDevice(ports.stdout);
          if (!device) {
            return { app: "ip_address", ip: null };
          }
          let ipResult: MacCommandResult;
          try {
            ipResult = await shell(IPCONFIG_PATH, ["getifaddr", device]);
          } catch (cause) {
            return { error: `ip_address read spawn failed: ${cause instanceof Error ? cause.message : String(cause)}` };
          }
          return { app: "ip_address", ip: parseIpAddressOutput(ipResult.stdout) };
        }
        const [bin, argv] = app === "battery" ? [PMSET_PATH, ["-g", "batt"]] : [DF_PATH, ["-h", "/"]];
        let shellResult: MacCommandResult;
        try {
          shellResult = await shell(bin, argv);
        } catch (cause) {
          return { error: `${app} read spawn failed: ${cause instanceof Error ? cause.message : String(cause)}` };
        }
        if (shellResult.timedOut || shellResult.exitCode !== 0) {
          return { error: `${app} read failed: ${shellResult.stderr.trim().slice(0, 200) || "timed out"}` };
        }
        return app === "battery" ? parseBatteryOutput(shellResult.stdout) : parseStorageOutput(shellResult.stdout);
      }
      const query = typeof args["query"] === "string" ? args["query"].trim() : "";
      if (app === "contacts" && query.length === 0) {
        return { error: "reading contacts needs a 'query' — the name to look up (e.g. 'Jane')" };
      }
      let result: MacCommandResult;
      try {
        result = await runner(buildReadScript(app as MacReadApp, query));
      } catch (cause) {
        return { error: `osascript spawn failed: ${cause instanceof Error ? cause.message : String(cause)}` };
      }
      if (result.timedOut) {
        return { error: `osascript timed out after ${OSASCRIPT_TIMEOUT_MS.toString()}ms (an unanswered Automation permission prompt?)` };
      }
      if (result.exitCode !== 0) {
        if (isPermissionError(result.stderr)) {
          return { error: `permission denied for ${app} — grant access in System Settings → Privacy & Security → Automation` };
        }
        return { error: `osascript failed: ${result.stderr.trim().slice(0, 300)}` };
      }
      return parseReadOutput(app as MacReadApp, result.stdout);
    }
  };
}
