import { describe, expect, it } from "vitest";

import { buildTasksRegistry } from "../src/registry-builders/tasks.js";
import type { MuseEnvironment } from "../src/index.js";

const env = (over: Record<string, string | undefined> = {}): MuseEnvironment => over as unknown as MuseEnvironment;
const ids = (over?: Record<string, string | undefined>): readonly string[] => buildTasksRegistry(env(over)).list().map((p) => p.id);

describe("buildTasksRegistry — env -> TasksProviderRegistry", () => {
  describe("provider-list parsing", () => {
    it("defaults to the local provider when MUSE_TASKS_PROVIDERS is unset", () => {
      expect(ids()).toEqual(["local"]);
    });

    it("defaults to local for an empty or whitespace-only value", () => {
      expect(ids({ MUSE_TASKS_PROVIDERS: "" })).toEqual(["local"]);
      expect(ids({ MUSE_TASKS_PROVIDERS: "   " })).toEqual(["local"]);
    });

    it("splits a comma list, trimming, lowercasing, and dropping empty entries", () => {
      expect(ids({ MUSE_TASKS_PROVIDERS: "  LOCAL , Apple-Reminders ,, " })).toEqual(["local", "apple-reminders"]);
    });

    it("registers requested providers in the order given (primary = first)", () => {
      const registry = buildTasksRegistry(env({ MUSE_TASKS_PROVIDERS: "apple-reminders,local" }));
      expect(registry.list().map((p) => p.id)).toEqual(["apple-reminders", "local"]);
      expect(registry.primary()?.id).toBe("apple-reminders");
    });

    it("collapses a duplicate id (registry is keyed by provider id)", () => {
      expect(ids({ MUSE_TASKS_PROVIDERS: "local,local" })).toEqual(["local"]);
    });

    it("silently skips an unknown provider id", () => {
      expect(ids({ MUSE_TASKS_PROVIDERS: "local,bogus" })).toEqual(["local"]);
      expect(buildTasksRegistry(env({ MUSE_TASKS_PROVIDERS: "bogus" })).list()).toHaveLength(0);
    });
  });

  describe("local provider", () => {
    it("is always buildable and reports has('local')", () => {
      const registry = buildTasksRegistry(env());
      expect(registry.has("local")).toBe(true);
    });
  });

  describe("apple-reminders provider", () => {
    it("registers with or without a configured list scope", () => {
      expect(ids({ MUSE_TASKS_PROVIDERS: "apple-reminders" })).toEqual(["apple-reminders"]);
      expect(ids({ MUSE_TASKS_PROVIDERS: "apple-reminders", MUSE_APPLE_REMINDERS_LIST: "Groceries" })).toEqual([
        "apple-reminders"
      ]);
    });
  });

  describe("notion provider — credential gate (silent skip until setup is complete)", () => {
    it("registers when both token and database id are present", () => {
      expect(
        ids({ MUSE_TASKS_PROVIDERS: "notion", MUSE_NOTION_TASKS_TOKEN: "secret", MUSE_NOTION_TASKS_DATABASE_ID: "db123" })
      ).toEqual(["notion"]);
    });

    it("is skipped when the token is missing", () => {
      expect(ids({ MUSE_TASKS_PROVIDERS: "notion", MUSE_NOTION_TASKS_DATABASE_ID: "db123" })).toEqual([]);
    });

    it("is skipped when the database id is missing", () => {
      expect(ids({ MUSE_TASKS_PROVIDERS: "notion", MUSE_NOTION_TASKS_TOKEN: "secret" })).toEqual([]);
    });

    it("is skipped when both credentials are missing, leaving other providers intact", () => {
      expect(ids({ MUSE_TASKS_PROVIDERS: "local,notion" })).toEqual(["local"]);
    });

    it("still registers when the optional property overrides are supplied", () => {
      expect(
        ids({
          MUSE_NOTION_TASKS_DATABASE_ID: "db123",
          MUSE_NOTION_TASKS_PROVIDERS: undefined,
          MUSE_NOTION_TASKS_STATUS_DONE: "Complete",
          MUSE_NOTION_TASKS_STATUS_OPEN: "Todo",
          MUSE_NOTION_TASKS_STATUS_PROPERTY: "State",
          MUSE_NOTION_TASKS_TITLE_PROPERTY: "Task",
          MUSE_NOTION_TASKS_TOKEN: "secret",
          MUSE_TASKS_PROVIDERS: "notion"
        })
      ).toEqual(["notion"]);
    });
  });
});
