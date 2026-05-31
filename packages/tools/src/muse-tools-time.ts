import type { JsonObject } from "@muse/shared";

import type { MuseTool } from "./index.js";
import {
  readOptionalDate,
  readOptionalNumber,
  readOptionalString,
  readRequiredDate
} from "./muse-tools-helpers.js";

/**
 * Time / date / scheduling tools — the subset of `createMuseTools`
 * that depends on a wall clock or operates on ISO-8601 / cron
 * strings. Kept together so the time-only humanizers
 * (`humanizeRelativeMs` / `humanizeDurationMs`) and the weekday +
 * cron-mode tables stay co-located with their callers.
 */

export function createTimeNowTool(now: () => Date): MuseTool {
  return {
    definition: {
      description:
        "Returns the CURRENT wall-clock instant right now: ISO-8601 UTC, epoch milliseconds, the current day-of-week (e.g. 'Tuesday'), and the resolved IANA timezone. " +
        "Use when the user asks what the time, date, or day-of-week IS RIGHT NOW or today (e.g. 'what time is it', 'what day is it today in Seoul', \"what's today's date\", Korean '지금 몇 시야', '오늘 며칠이야', '오늘 무슨 요일이야'). " +
        "Do NOT use to find the date of a FUTURE named weekday ('when is next Monday') — that is next_weekday_date.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          timezone: {
            description: "Optional IANA timezone (e.g. 'Asia/Seoul', 'UTC'). Defaults to UTC.",
            type: "string"
          }
        },
        type: "object"
      },
      domain: "core",
      keywords: ["time", "clock", "now", "date", "day", "weekday", "today"],
      name: "time_now",
      risk: "read"
    },
    execute: (args): JsonObject => {
      const at = now();
      const timezone = readOptionalString(args, "timezone") ?? "UTC";
      let formatted: string;
      let dayOfWeek: string;
      try {
        formatted = new Intl.DateTimeFormat("en-CA", {
          dateStyle: "short",
          timeStyle: "long",
          timeZone: timezone
        }).format(at);
        dayOfWeek = new Intl.DateTimeFormat("en-US", {
          timeZone: timezone,
          weekday: "long"
        }).format(at);
      } catch {
        return { error: `unsupported timezone: ${timezone}` };
      }
      return {
        dayOfWeek,
        epochMs: at.getTime(),
        formatted,
        iso: at.toISOString(),
        timezone
      } satisfies JsonObject;
    }
  };
}

export function createTimeDiffTool(): MuseTool {
  return {
    definition: {
      description:
        "Computes the signed duration between two ISO-8601 timestamps. Returns milliseconds plus a humanized string. " +
        "Negative durations indicate `to` precedes `from`. " +
        "Use when you have TWO explicit timestamps to compare; for 'how long ago / until' relative to NOW, use time_relative instead.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          from: { description: "ISO-8601 starting timestamp.", type: "string" },
          to: { description: "ISO-8601 ending timestamp.", type: "string" }
        },
        required: ["from", "to"],
        type: "object"
      },
      domain: "core",
      keywords: ["time", "duration", "diff", "interval"],
      name: "time_diff",
      risk: "read"
    },
    execute: (args): JsonObject => {
      const from = readRequiredDate(args, "from");
      const to = readRequiredDate(args, "to");
      if (!from || !to) {
        return { error: "from/to must be valid ISO-8601 strings" };
      }
      const ms = to.getTime() - from.getTime();
      return { humanized: humanizeDurationMs(ms), milliseconds: ms } satisfies JsonObject;
    }
  };
}

export function createTimeAddTool(): MuseTool {
  return {
    definition: {
      description:
        "Adds a signed duration (`milliseconds`, `seconds`, `minutes`, `hours`, `days`) to a base ISO-8601 timestamp and returns the resulting ISO timestamp. Any combination of fields is summed.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          base: { description: "ISO-8601 base timestamp.", type: "string" },
          days: { type: "number" },
          hours: { type: "number" },
          milliseconds: { type: "number" },
          minutes: { type: "number" },
          seconds: { type: "number" }
        },
        required: ["base"],
        type: "object"
      },
      domain: "core",
      keywords: ["time", "schedule", "add", "shift"],
      name: "time_add",
      risk: "read"
    },
    execute: (args): JsonObject => {
      const base = readRequiredDate(args, "base");
      if (!base) {
        return { error: "base must be a valid ISO-8601 string" };
      }
      const offsetMs =
        readOptionalNumber(args, "milliseconds") +
        readOptionalNumber(args, "seconds") * 1000 +
        readOptionalNumber(args, "minutes") * 60_000 +
        readOptionalNumber(args, "hours") * 3_600_000 +
        readOptionalNumber(args, "days") * 86_400_000;
      const result = new Date(base.getTime() + offsetMs);
      if (Number.isNaN(result.getTime())) {
        return { error: "computed date is outside the representable range" };
      }
      return { iso: result.toISOString(), offsetMs } satisfies JsonObject;
    }
  };
}

export function createTimeRelativeTool(now: () => Date): MuseTool {
  return {
    definition: {
      description:
        "Given an ISO-8601 timestamp `at`, returns a humanized relative phrase ('in 2h', '3d ago', 'just now'), the signed millisecond delta, and a direction ('past' | 'future' | 'now'). " +
        "An optional `reference` ISO timestamp pins the comparison point; otherwise the current clock is used. Useful for surfacing 'when' answers without a follow-up calculation. " +
        "Use when comparing ONE timestamp to now (or a reference) — 'how long ago was X', 'how long until Y', Korean 'X가 얼마나 지났어 / 지났 거야', 'X까지 며칠 남았어', 'X에서 지금까지 얼마나 됐어' (a single date measured against now, even when that date is an explicit ISO value); do NOT use when comparing two explicit timestamps to each other — use time_diff.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          at: { description: "ISO-8601 timestamp to describe.", type: "string" },
          reference: {
            description: "Optional ISO-8601 reference timestamp. Defaults to now.",
            type: "string"
          }
        },
        required: ["at"],
        type: "object"
      },
      domain: "core",
      keywords: ["time", "relative", "humanize", "ago"],
      name: "time_relative",
      risk: "read"
    },
    execute: (args): JsonObject => {
      const at = readRequiredDate(args, "at");
      if (!at) {
        return { error: "at must be a valid ISO-8601 string" };
      }
      const ref = readOptionalDate(args, "reference");
      if (ref.kind === "invalid") {
        return { error: "reference must be a valid ISO-8601 string" };
      }
      const reference = ref.kind === "date" ? ref.date : now();
      const deltaMs = at.getTime() - reference.getTime();
      const direction: "past" | "future" | "now" =
        Math.abs(deltaMs) < 1_000 ? "now" : deltaMs > 0 ? "future" : "past";
      const humanized = humanizeRelativeMs(deltaMs);
      return { deltaMs, direction, humanized } satisfies JsonObject;
    }
  };
}

export function createNextWeekdayTool(now: () => Date): MuseTool {
  return {
    definition: {
      description:
        "Requires a specific NAMED weekday in the request (e.g. 'Monday', 'this coming Friday'). " +
        "Do NOT call this for 'what day is it (right now / today)' or any CURRENT date/time question — that is time_now. " +
        "If the user did not name a weekday, this is the WRONG tool. " +
        "When a weekday IS named, resolves it to the ISO date of its next UPCOMING occurrence (always strictly future, never today) so the agent can stamp reminders or schedules without inline math — e.g. 'when is next Monday', 'the date of this coming Friday'. " +
        "Optional `reference` (ISO-8601) pins the comparison point; otherwise the current clock is used. " +
        "If the reference is itself that weekday, returns the occurrence one week later. Returns `{ iso, weekday }` (UTC date stripped of time-of-day).",
      inputSchema: {
        additionalProperties: false,
        properties: {
          reference: {
            description: "Optional ISO-8601 reference timestamp. Defaults to now.",
            type: "string"
          },
          weekday: {
            description: "Weekday name or 3-letter abbreviation (case-insensitive).",
            type: "string"
          }
        },
        required: ["weekday"],
        type: "object"
      },
      domain: "core",
      keywords: ["calendar", "schedule", "date", "upcoming", "future"],
      name: "next_weekday_date",
      risk: "read"
    },
    execute: (args): JsonObject => {
      const weekdayInput = typeof args["weekday"] === "string" ? (args["weekday"] as string).trim().toLowerCase() : "";
      if (weekdayInput.length === 0) {
        return { error: "weekday is required" };
      }
      const targetIndex = WEEKDAY_NAMES.findIndex((aliases) => aliases.includes(weekdayInput));
      if (targetIndex < 0) {
        return { error: `weekday must be one of: ${WEEKDAY_NAMES.map((aliases) => aliases[0]).join(", ")}` };
      }
      const ref = readOptionalDate(args, "reference");
      if (ref.kind === "invalid") {
        return { error: "reference must be a valid ISO-8601 string" };
      }
      const reference = ref.kind === "date" ? ref.date : now();
      const referenceDay = new Date(Date.UTC(
        reference.getUTCFullYear(),
        reference.getUTCMonth(),
        reference.getUTCDate()
      ));
      const currentIndex = referenceDay.getUTCDay();
      let delta = (targetIndex - currentIndex + 7) % 7;
      if (delta === 0) {
        delta = 7;
      }
      const next = new Date(referenceDay.getTime() + delta * 86_400_000);
      const iso = next.toISOString().slice(0, 10);
      const weekdayName = WEEKDAY_NAMES[targetIndex]?.[0] ?? weekdayInput;
      return { iso, weekday: weekdayName } satisfies JsonObject;
    }
  };
}

export function createCronForDatetimeTool(): MuseTool {
  return {
    definition: {
      description:
        "Converts an ISO-8601 datetime to a cron expression for the scheduler. " +
        "`mode` controls the recurrence: 'once' (default) returns a yearly-recurring expression at that exact minute/hour/day/month — disable the scheduled job after it fires for true one-shot semantics; 'daily' fires every day at that hour:minute; 'weekly' fires every week on that weekday at that hour:minute; 'monthly' fires every month on that day-of-month at that hour:minute (a day > 28 is skipped in shorter months — the result carries a `warning` then). " +
        "Bridge for natural-language reminders: compose with `time_now` + `time_add` / `next_weekday_date` / `time_relative` to build the ISO, then pass it here, then call `scheduler_create_job` with the returned cron.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          iso: { description: "ISO-8601 datetime (UTC).", type: "string" },
          mode: {
            description: "'once' | 'daily' | 'weekly' | 'monthly'. Defaults to 'once'.",
            type: "string"
          }
        },
        required: ["iso"],
        type: "object"
      },
      domain: "core",
      keywords: ["cron", "schedule", "reminder", "datetime", "scheduler"],
      name: "cron_for_datetime",
      risk: "read"
    },
    execute: (args): JsonObject => {
      const isoInput = typeof args["iso"] === "string" ? (args["iso"] as string).trim() : "";
      const modeInput = typeof args["mode"] === "string" ? (args["mode"] as string).trim().toLowerCase() : "once";
      const mode = modeInput.length === 0 ? "once" : modeInput;

      if (!CRON_DATETIME_MODES.has(mode)) {
        return { error: `mode must be one of: once, daily, weekly, monthly (got '${mode}')` };
      }

      if (!isoInput) {
        return { error: "iso is required" };
      }

      const at = new Date(isoInput);

      if (Number.isNaN(at.getTime())) {
        return { error: `invalid ISO-8601 datetime: '${isoInput}'` };
      }

      const minute = at.getUTCMinutes();
      const hour = at.getUTCHours();
      const dayOfMonth = at.getUTCDate();
      const month = at.getUTCMonth() + 1;
      const dayOfWeek = at.getUTCDay();

      let cron: string;
      switch (mode) {
        case "daily":
          cron = `${minute} ${hour} * * *`;
          break;
        case "weekly":
          cron = `${minute} ${hour} * * ${dayOfWeek}`;
          break;
        case "monthly":
          cron = `${minute} ${hour} ${dayOfMonth} * *`;
          break;
        default:
          cron = `${minute} ${hour} ${dayOfMonth} ${month} *`;
          break;
      }

      // cron-parser skips (never clamps) a day-of-month a month
      // lacks, so a monthly rule on the 29th–31st silently never
      // fires in shorter months. Surface it so the agent can warn
      // the user instead of a reminder vanishing for ~5 months/year.
      if (mode === "monthly" && dayOfMonth > 28) {
        return {
          cron,
          iso: at.toISOString(),
          mode,
          warning: `monthly schedule on day ${dayOfMonth} will not fire in months without that day (e.g. February); use a day <= 28 for a guaranteed monthly run`
        } satisfies JsonObject;
      }

      return { cron, iso: at.toISOString(), mode } satisfies JsonObject;
    }
  };
}

const CRON_DATETIME_MODES = new Set(["once", "daily", "weekly", "monthly"]);

const WEEKDAY_NAMES: ReadonlyArray<readonly string[]> = [
  ["sunday", "sun"],
  ["monday", "mon"],
  ["tuesday", "tue", "tues"],
  ["wednesday", "wed"],
  ["thursday", "thu", "thur", "thurs"],
  ["friday", "fri"],
  ["saturday", "sat"]
];

function humanizeRelativeMs(ms: number): string {
  const absolute = Math.abs(ms);
  if (absolute < 1_000) {
    return "just now";
  }
  const days = Math.floor(absolute / 86_400_000);
  const hours = Math.floor((absolute % 86_400_000) / 3_600_000);
  const minutes = Math.floor((absolute % 3_600_000) / 60_000);
  const seconds = Math.floor((absolute % 60_000) / 1_000);
  const segments: string[] = [];
  if (days > 0) {
    segments.push(`${days}d`);
  }
  if (hours > 0 && days < 2) {
    segments.push(`${hours}h`);
  }
  if (minutes > 0 && days === 0) {
    segments.push(`${minutes}m`);
  }
  if (segments.length === 0) {
    segments.push(`${seconds}s`);
  }
  const unit = segments.join(" ");
  return ms >= 0 ? `in ${unit}` : `${unit} ago`;
}

function humanizeDurationMs(ms: number): string {
  const sign = ms < 0 ? "-" : "";
  const absolute = Math.abs(ms);
  const hours = Math.floor(absolute / 3_600_000);
  const minutes = Math.floor((absolute % 3_600_000) / 60_000);
  const seconds = Math.floor((absolute % 60_000) / 1_000);
  const millis = absolute % 1_000;
  const parts: string[] = [];
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }
  if (seconds > 0 && hours === 0) {
    parts.push(`${seconds}s`);
  }
  if (parts.length === 0) {
    parts.push(`${millis}ms`);
  }
  return `${sign}${parts.join(" ")}`;
}
