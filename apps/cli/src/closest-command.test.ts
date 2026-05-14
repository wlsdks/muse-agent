import { describe, expect, it } from "vitest";

import { closestCommandName, levenshteinDistance } from "./closest-command.js";

describe("levenshteinDistance", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshteinDistance("status", "status")).toBe(0);
  });

  it("counts single-character insertion / deletion / substitution as 1", () => {
    expect(levenshteinDistance("statu", "status")).toBe(1);   // insertion
    expect(levenshteinDistance("statuss", "status")).toBe(1); // deletion
    expect(levenshteinDistance("statux", "status")).toBe(1);  // substitution
  });

  it("returns the longer length when one side is empty", () => {
    expect(levenshteinDistance("", "status")).toBe(6);
    expect(levenshteinDistance("status", "")).toBe(6);
    expect(levenshteinDistance("", "")).toBe(0);
  });
});

describe("closestCommandName", () => {
  const commands = ["ask", "brief", "chat", "history", "remember", "status", "today", "trust"];

  it("returns the closest candidate for a single-edit typo", () => {
    expect(closestCommandName("statu", commands)).toBe("status");
    expect(closestCommandName("histroy", commands)).toBe("history");
  });

  it("is case-insensitive — `STATUS` still suggests `status`", () => {
    expect(closestCommandName("STATUS", commands)).toBe("status");
    expect(closestCommandName("Histroy", commands)).toBe("history");
  });

  it("returns undefined when nothing is close enough (length-aware cap)", () => {
    expect(closestCommandName("xyz", commands)).toBeUndefined();
    expect(closestCommandName("totally-unrelated-input", commands)).toBeUndefined();
  });

  it("returns undefined on empty / whitespace-only input", () => {
    expect(closestCommandName("", commands)).toBeUndefined();
    expect(closestCommandName("   ", commands)).toBeUndefined();
  });

  it("honours an explicit maxDistance override", () => {
    // With cap=0, only exact matches qualify.
    expect(closestCommandName("statu", commands, 0)).toBeUndefined();
    expect(closestCommandName("status", commands, 0)).toBe("status");
    // With cap=5, even far inputs land on something.
    expect(closestCommandName("xyz", commands, 5)).toBeDefined();
  });

  it("breaks ties by candidate order (stable across calls)", () => {
    // "histori" sits one edit from both "history" (insert 'y') and
    // "historic" (substitute 'i' for 'c') — the first one in the
    // candidate list wins so suggestions stay deterministic.
    expect(closestCommandName("histori", ["history", "historic"])).toBe("history");
    expect(closestCommandName("histori", ["historic", "history"])).toBe("historic");
  });
});
