import { describe, expect, it } from "vitest";

import {
  NOTION_DEFAULT_ENDPOINT,
  NOTION_DEFAULT_TITLE_PROPERTY,
  NOTION_DEFAULT_VERSION,
  NOTION_LIST_MAX_PAGES,
  extractTitleString,
  isRecordArray,
  isTransientNotionStatus,
  mapNotionStatus
} from "../src/notion-shared.js";

describe("notion-shared defaults", () => {
  it("pins the api.notion.com endpoint/version/title/page-cap constants", () => {
    expect(NOTION_DEFAULT_ENDPOINT).toBe("https://api.notion.com/v1");
    expect(NOTION_DEFAULT_VERSION).toBe("2022-06-28");
    expect(NOTION_DEFAULT_TITLE_PROPERTY).toBe("Name");
    expect(NOTION_LIST_MAX_PAGES).toBe(10);
  });
});

describe("isTransientNotionStatus", () => {
  it("treats 429 and 5xx as transient (retryable), 2xx/4xx as terminal", () => {
    expect(isTransientNotionStatus(429)).toBe(true);
    expect(isTransientNotionStatus(500)).toBe(true);
    expect(isTransientNotionStatus(599)).toBe(true);
    expect(isTransientNotionStatus(200)).toBe(false);
    expect(isTransientNotionStatus(401)).toBe(false);
    expect(isTransientNotionStatus(404)).toBe(false);
  });
});

describe("mapNotionStatus", () => {
  it("maps auth/not-found/rate-limit to codes and falls back to HTTP_<n>", () => {
    expect(mapNotionStatus(401)).toBe("NOTION_AUTH");
    expect(mapNotionStatus(403)).toBe("NOTION_AUTH");
    expect(mapNotionStatus(404)).toBe("NOTION_NOT_FOUND");
    expect(mapNotionStatus(429)).toBe("NOTION_RATE_LIMIT");
    expect(mapNotionStatus(500)).toBe("HTTP_500");
  });
});

describe("isRecordArray", () => {
  it("returns the array at the key, or [] for non-object / non-array / missing", () => {
    expect(isRecordArray({ results: [1, 2] }, "results")).toEqual([1, 2]);
    expect(isRecordArray({ results: "nope" }, "results")).toEqual([]);
    expect(isRecordArray({}, "results")).toEqual([]);
    expect(isRecordArray(null, "results")).toEqual([]);
    expect(isRecordArray("string", "results")).toEqual([]);
  });
});

describe("extractTitleString", () => {
  it("joins plain_text (preferred) / text.content rich-text runs, undefined when empty", () => {
    expect(extractTitleString({ title: [{ plain_text: "Hello " }, { plain_text: "world" }] })).toBe("Hello world");
    expect(extractTitleString({ title: [{ text: { content: "from content" } }] })).toBe("from content");
    expect(extractTitleString({ title: [] })).toBeUndefined();
    expect(extractTitleString({ title: "not-an-array" })).toBeUndefined();
    expect(extractTitleString(null)).toBeUndefined();
  });
});
