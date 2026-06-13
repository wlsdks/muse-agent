import { describe, expect, it } from "vitest";

import type { SnapshotElement } from "../src/controller.js";
import { filterElements, looksUnsettled, matchElement, matchElementResult, matchOption } from "../src/matcher.js";

const els: SnapshotElement[] = [
  { name: "Sign in", ref: 0, role: "button" },
  { name: "Sign up", ref: 1, role: "link" },
  { name: "Search", ref: 2, role: "textbox" },
  { name: "Add to cart", ref: 3, role: "button" },
  { name: "Home", ref: 4, role: "link" }
];

describe("matchElement — deterministic grounding (model names, code resolves)", () => {
  it("exact name wins", () => {
    expect(matchElement(els, "Sign in", "click")?.ref).toBe(0);
  });

  it("substring: 'the Sign in button' resolves to 'Sign in'", () => {
    expect(matchElement(els, "the Sign in button", "click")?.ref).toBe(0);
  });

  it("is case-insensitive", () => {
    expect(matchElement(els, "ADD TO CART", "click")?.ref).toBe(3);
  });

  it("disambiguates Sign in vs Sign up by the distinctive word", () => {
    expect(matchElement(els, "sign up", "click")?.ref).toBe(1);
  });

  it("role bonus breaks ties toward the acting intent", () => {
    const ambiguous: SnapshotElement[] = [
      { name: "go", ref: 0, role: "link" },
      { name: "go", ref: 1, role: "textbox" }
    ];
    expect(matchElement(ambiguous, "go", "type")?.ref).toBe(1);
    expect(matchElement(ambiguous, "go", "click")?.ref).toBe(0);
  });

  it("returns undefined when nothing matches", () => {
    expect(matchElement(els, "checkout", "click")).toBeUndefined();
    expect(matchElement(els, "   ", "click")).toBeUndefined();
  });
});

describe("matchElement — ordinal targeting among repeated controls", () => {
  const rows: SnapshotElement[] = [
    { name: "View", ref: 0, role: "button" },
    { name: "View", ref: 1, role: "button" },
    { name: "View", ref: 2, role: "button" }
  ];

  it("'the second View' picks the 2nd in DOM order", () => {
    expect(matchElement(rows, "the second View", "click")?.ref).toBe(1);
  });

  it("'2nd View' (numeric) works too", () => {
    expect(matchElement(rows, "2nd View", "click")?.ref).toBe(1);
  });

  it("'last View' picks the final one", () => {
    expect(matchElement(rows, "last View", "click")?.ref).toBe(2);
  });

  it("an out-of-range ordinal clamps to the last match", () => {
    expect(matchElement(rows, "fifth View", "click")?.ref).toBe(2);
  });

  it("a literal label that starts with an ordinal word is NOT mis-stripped", () => {
    // only one 'First name' field exists → 'first' is part of the label, not an ordinal
    const fields: SnapshotElement[] = [
      { name: "First name", ref: 0, role: "textbox" },
      { name: "Last name", ref: 1, role: "textbox" }
    ];
    expect(matchElement(fields, "First name", "type")?.ref).toBe(0);
    expect(matchElement(fields, "Last name", "type")?.ref).toBe(1);
  });
});

describe("matchElementResult — surfaces ambiguity instead of guessing (fail-close for acts)", () => {
  it("a single best match resolves to a unique element", () => {
    const result = matchElementResult(els, "Sign in", "click");
    expect(result.kind).toBe("match");
    expect(result.kind === "match" && result.element.ref).toBe(0);
  });

  it("two DISTINCT controls tied at the top score are AMBIGUOUS, not a silent first-pick", () => {
    const twins: SnapshotElement[] = [
      { name: "Delete", ref: 0, role: "button" },
      { name: "Delete", ref: 1, role: "button" }
    ];
    const result = matchElementResult(twins, "Delete", "click");
    expect(result.kind).toBe("ambiguous");
    expect(result.kind === "ambiguous" && result.candidates.map((c) => c.ref)).toEqual([0, 1]);
  });

  it("an explicit ordinal disambiguates a tie → a unique match (not ambiguous)", () => {
    const twins: SnapshotElement[] = [
      { name: "Delete", ref: 0, role: "button" },
      { name: "Delete", ref: 1, role: "button" }
    ];
    expect(matchElementResult(twins, "the second Delete", "click")).toMatchObject({ kind: "match", element: { ref: 1 } });
  });

  it("a clear winner above a weaker match is NOT ambiguous", () => {
    // 'Sign in' scores 100 (exact); 'Sign up' only shares a word → far lower.
    const result = matchElementResult(els, "Sign in", "click");
    expect(result.kind).toBe("match");
  });

  it("the type-intent typeable-preference still yields a unique match, not ambiguity", () => {
    // 'Search' button (100) ties 'Search' textbox would tie on base, but the type
    // intent picks the lone typeable element — a unique resolution, not ambiguous.
    const shop: SnapshotElement[] = [
      { name: "Search", ref: 0, role: "button" },
      { name: "Search", ref: 1, role: "textbox" }
    ];
    expect(matchElementResult(shop, "Search", "type")).toMatchObject({ kind: "match", element: { ref: 1 } });
  });

  it("no match → kind 'none'", () => {
    expect(matchElementResult(els, "checkout", "click").kind).toBe("none");
  });

  it("matchElement (back-compat) still returns the first of an ambiguous set", () => {
    const twins: SnapshotElement[] = [
      { name: "Delete", ref: 0, role: "button" },
      { name: "Delete", ref: 1, role: "button" }
    ];
    expect(matchElement(twins, "Delete", "click")?.ref).toBe(0);
  });
});

describe("filterElements — focused browser_read", () => {
  it("returns only loosely-matching elements", () => {
    expect(filterElements(els, "sign").map((e) => e.ref)).toEqual([0, 1]);
  });

  it("an empty query returns everything", () => {
    expect(filterElements(els, "")).toHaveLength(5);
  });
});

describe("matchOption — deterministic <select> option grounding", () => {
  const options = [
    { label: "Select a country", value: "" },
    { label: "Canada", value: "CA" },
    { label: "South Korea", value: "KR" },
    { label: "United States", value: "US" }
  ];

  it("exact label wins (case-insensitive)", () => {
    expect(matchOption(options, "canada")?.value).toBe("CA");
  });

  it("substring of the label resolves ('korea' → South Korea)", () => {
    expect(matchOption(options, "korea")?.value).toBe("KR");
  });

  it("matches by value when the label misses ('US')", () => {
    expect(matchOption(options, "US")?.value).toBe("US");
  });

  it("prefers the exact label over a substring hit", () => {
    const shadowed = [
      { label: "Red wine", value: "rw" },
      { label: "Red", value: "r" }
    ];
    expect(matchOption(shadowed, "red")?.value).toBe("r");
  });

  it("returns undefined when nothing matches or the text is blank", () => {
    expect(matchOption(options, "Mars")).toBeUndefined();
    expect(matchOption(options, "  ")).toBeUndefined();
  });
});

describe("looksUnsettled — SPA delayed-render detection", () => {
  it("an element-less, near-empty snapshot is unsettled (worth a retry)", () => {
    expect(looksUnsettled({ elements: [], text: "", title: "", url: "https://a.test/" })).toBe(true);
    expect(looksUnsettled({ elements: [], text: "Loading…", title: "App", url: "https://a.test/" })).toBe(true);
  });

  it("any interactive element or real text means settled", () => {
    expect(looksUnsettled({ elements: [{ name: "Go", ref: 0, role: "button" }], text: "", title: "", url: "https://a.test/" })).toBe(false);
    const text = "A real paragraph of rendered page content that is clearly more than a loading stub.";
    expect(looksUnsettled({ elements: [], text, title: "Docs", url: "https://a.test/" })).toBe(false);
  });
});

describe("matchElement — type intent must not land on untypeable elements", () => {
  it("'search box' resolves to the INPUT, not the higher-substring-scoring 'Search' button", () => {
    const shop: SnapshotElement[] = [
      { name: "Search", ref: 0, role: "button" },
      { name: "Search products", ref: 1, role: "textbox" }
    ];
    expect(matchElement(shop, "search box", "type")?.ref).toBe(1);
  });

  it("falls back to a button only when NO typeable element matches at all", () => {
    const onlyButton: SnapshotElement[] = [{ name: "Search", ref: 0, role: "button" }];
    expect(matchElement(onlyButton, "search", "type")?.ref).toBe(0);
  });
});
