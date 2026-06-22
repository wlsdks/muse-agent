import {
  aggregateActivitySignals,
  detectTimeOfDayPatterns,
  detectWeeklyTaskPatterns,
  type PatternMatch
} from "@muse/memory";
import type { JsonObject, JsonValue } from "@muse/shared";

import { errorMessage } from "@muse/mcp";
import type { LoopbackMcpServer } from "@muse/mcp";
import {
  readPatternsFired,
  writePatternsFired
} from "@muse/stores";

/**
 * `muse.pattern` loopback MCP server — exposes the
 * pattern-detection track to the agent without ever letting it
 * forge a pattern or fake a delivery.
 *
 * Tools:
 *   - `list` (read) — run the aggregator + both detectors RIGHT
 *     NOW and return every cluster they find. Audit shape: no
 *     cooldown filter, no currentSlotOnly. Useful when the user
 *     asks "what routines have you noticed?".
 *   - `fired_history` (read) — list the cooldown sidecar
 *     newest-first so the agent can answer "did you proactively
 *     send anything this morning?".
 *   - `reset` (write) — wipe the cooldown sidecar with explicit
 *     `confirm: true`. Mirrors the CLI's `pattern reset --yes`.
 *
 * Intentionally NO `fire` / `record` tool. The daemon is the only
 * authorised firer; letting the agent record a fire would
 * sidestep the cooldown gate the design doc enforces.
 */
export interface PatternsMcpServerOptions {
  /** Cooldown sidecar (`~/.muse/patterns-fired.json`). */
  readonly file: string;
  /** Three signal-source overrides; default to `~/.muse/*` via the aggregator. */
  readonly activityFile?: string;
  readonly tasksFile?: string;
  readonly notesDir?: string;
  readonly homeDir?: string;
  readonly now?: () => Date;
  readonly maxListEntries?: number;
}

export function createPatternsMcpServer(options: PatternsMcpServerOptions): LoopbackMcpServer {
  const file = options.file;
  const now = options.now ?? (() => new Date());
  const maxListEntries = Math.max(1, Math.trunc(options.maxListEntries ?? 50));

  const signalOptions = {
    ...(options.activityFile ? { activityFile: options.activityFile } : {}),
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.notesDir ? { notesDir: options.notesDir } : {}),
    ...(options.tasksFile ? { tasksFile: options.tasksFile } : {})
  };

  return {
    description:
      "Pattern-detection audit + cooldown management. Run detectors now, see fired history, reset cooldown.",
    name: "muse.pattern",
    tools: [
      {
        description:
          "Run the two detectors RIGHT NOW and return every cluster they find, regardless of cooldown. " +
          "Sorted by confidence desc up to `" + maxListEntries.toString() + "` entries. Optional " +
          "`minConfidence` (0..1) drops weaker matches; default 0 (show every cluster). Use to answer " +
          "'what routines have you noticed?' / 'when do I usually do X?'.",
        execute: async (args): Promise<JsonObject> => {
          const minConfidenceRaw = args["minConfidence"];
          const minConfidence = typeof minConfidenceRaw === "number"
            && Number.isFinite(minConfidenceRaw)
            && minConfidenceRaw >= 0 && minConfidenceRaw <= 1
            ? minConfidenceRaw
            : 0;
          const limitRaw = args["limit"];
          const limit = typeof limitRaw === "number" && Number.isFinite(limitRaw)
            ? Math.max(1, Math.min(maxListEntries, Math.trunc(limitRaw)))
            : Math.min(maxListEntries, 20);
          try {
            const signals = await aggregateActivitySignals({ now: () => now().getTime(), ...signalOptions });
            const tod = detectTimeOfDayPatterns(now(), signals);
            const weekly = detectWeeklyTaskPatterns(now(), signals);
            const matches = [...tod, ...weekly]
              .filter((m) => m.confidence >= minConfidence)
              .sort((left, right) => right.confidence - left.confidence)
              .slice(0, limit);
            return {
              patterns: matches.map(serializePatternMatch) as JsonValue,
              total: matches.length
            };
          } catch (cause) {
            return { error: errorMessage(cause) };
          }
        },
        inputSchema: {
          additionalProperties: false,
          properties: {
            limit: { type: "number" },
            minConfidence: { description: "0..1 floor. Default 0.", type: "number" }
          },
          type: "object"
        },
        domain: "memory",
        name: "list",
        risk: "read"
      },
      {
        description:
          "Audit recent pattern firings. Returns the cooldown sidecar newest-first up to `limit` records " +
          "(default 20, cap " + maxListEntries.toString() + "). Use to answer 'did you send me anything " +
          "this morning?' / 'when was the last proactive nudge?'.",
        execute: async (args): Promise<JsonObject> => {
          const limitRaw = args["limit"];
          const limit = typeof limitRaw === "number" && Number.isFinite(limitRaw)
            ? Math.max(1, Math.min(maxListEntries, Math.trunc(limitRaw)))
            : Math.min(maxListEntries, 20);
          try {
            const records = await readPatternsFired(file);
            const sorted = [...records]
              .sort((left, right) => right.firedAtMs - left.firedAtMs)
              .slice(0, limit);
            return { fired: sorted as unknown as JsonValue, total: sorted.length };
          } catch (cause) {
            return { error: errorMessage(cause) };
          }
        },
        inputSchema: {
          additionalProperties: false,
          properties: { limit: { type: "number" } },
          type: "object"
        },
        domain: "memory",
        name: "fired_history",
        risk: "read"
      },
      {
        description:
          "Wipe the cooldown sidecar so every detected pattern becomes eligible to re-fire on the next tick. " +
          "Destructive — refuses unless `confirm: true` is passed. Use only when the user explicitly asks " +
          "to reset patterns (rare).",
        execute: async (args): Promise<JsonObject> => {
          const confirm = args["confirm"];
          if (confirm !== true) {
            return { error: "Refusing to reset without confirm:true (next tick may re-fire patterns immediately — pass confirm:true to proceed)" };
          }
          try {
            const before = await readPatternsFired(file);
            await writePatternsFired(file, []);
            return { cleared: true, removed: before.length };
          } catch (cause) {
            return { error: errorMessage(cause) };
          }
        },
        inputSchema: {
          additionalProperties: false,
          properties: { confirm: { type: "boolean" } },
          required: ["confirm"],
          type: "object"
        },
        domain: "memory",
        name: "reset",
        risk: "write"
      }
    ]
  };
}

function serializePatternMatch(match: PatternMatch): JsonObject {
  return {
    category: match.category,
    confidence: match.confidence,
    id: match.id,
    suggestion: match.suggestion,
    ...(match.category === "time-of-day-action"
      ? { bucket: match.bucket as unknown as JsonValue, relatedPaths: match.relatedPaths as unknown as JsonValue }
      : {
          bucket: match.bucket as unknown as JsonValue,
          missingThisWeek: match.missingThisWeek,
          relatedTitles: match.relatedTitles as unknown as JsonValue
        })
  };
}
