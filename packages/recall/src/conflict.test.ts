import { describe, expect, it } from "vitest";

import { conflictCueFromMatches, demoteStale, demoteStaleHits, detectSourceConflict, detectStaleMarker, formatSourceConflictWarning, groundingConflictCue } from "./conflict.js";
import type { RecallHit } from "./hit.js";

const hit = (ref: string, snippet: string, score = 0.7): RecallHit => ({ ref, score, snippet, source: "notes" });

describe("detectStaleMarker — explicit past/superseded cue (FORGETS on the retrieval side)", () => {
  it("flags KO supersession markers (예전에 / 았었 / 지금은 아니), not plain past tense", () => {
    expect(detectStaleMarker("예전에는 서울에 살았었다. 지금은 아니다.")).toBe(true);
    expect(detectStaleMarker("지금 내가 사는 도시는 부산이다.")).toBe(false);
    expect(detectStaleMarker("어제 친구와 회의했다.")).toBe(false);
  });

  it("flags EN supersession markers (used to / no longer / not anymore), not plain past/now", () => {
    expect(detectStaleMarker("I used to work out at a home gym, but not anymore.")).toBe(true);
    expect(detectStaleMarker("I now go to the gym near my office every morning.")).toBe(false);
    expect(detectStaleMarker("I visited Paris last year.")).toBe(false);
  });

  it("PRECISION: dropped weak markers do NOT fire on still-current statements", () => {
    // these previously false-fired on 더 이상 / previously / 었었 (④b-found); must be false now
    expect(detectStaleMarker("더 이상 질문 없습니다.")).toBe(false); // "no further questions"
    expect(detectStaleMarker("As previously discussed, the meeting is still on Tuesday.")).toBe(false);
    expect(detectStaleMarker("전에 먹었었던 그 음식이 지금도 최애다.")).toBe(false); // colloquial double-past, current
  });

  it("demoteStaleHits moves a stale entry BELOW the current one so top-1 is current (OUTCOME)", () => {
    const stale = hit("home_city_old", "예전에는 서울에 살았었다. 지금은 아니다.", 0.9);
    const current = hit("home_city", "지금 내가 사는 도시는 부산이다.", 0.5);
    const out = demoteStaleHits([stale, current]);
    expect(out[0]!.ref).toBe("home_city"); // current wins top-1 despite lower score
    expect(out[1]!.ref).toBe("home_city_old");
  });

  it("demoteStaleHits preserves relative order within each group (stable)", () => {
    const a = hit("a", "fresh one", 0.8);
    const b = hit("b", "fresh two", 0.7);
    const s = hit("s", "used to be true", 0.95);
    expect(demoteStaleHits([s, a, b]).map((h) => h.ref)).toEqual(["a", "b", "s"]);
  });

  it("demoteStale is the generic form demoteStaleHits delegates to — works over ANY shape given a text accessor", () => {
    const stale = { id: "old", text: "예전에는 서울에 살았었다. 지금은 아니다." };
    const current = { id: "new", text: "지금 내가 사는 도시는 부산이다." };
    const out = demoteStale([stale, current], (item) => item.text);
    expect(out.map((item) => item.id)).toEqual(["new", "old"]);
  });
});

describe("detectSourceConflict — evidence-vs-evidence contradiction (grounded≠true)", () => {
  it("flags two sources giving different values for the same labelled field", () => {
    const a = hit("wifi-old.md", "WiFi password: hunter2");
    const b = hit("wifi-new.md", "wifi password: swordfish99");
    const conflicts = detectSourceConflict([a, b]);
    expect(conflicts).toHaveLength(1);
    const c = conflicts[0]!;
    expect(c.field).toBe("wifi password");
    expect([c.valueA, c.valueB].sort()).toEqual(["hunter2", "swordfish99"]);
    expect([c.a.ref, c.b.ref].sort()).toEqual(["wifi-new.md", "wifi-old.md"]);
  });

  it("flags a comma-bearing ADDRESS conflict (London vs Paris) — value spans the comma for address-like labels", () => {
    const conflicts = detectSourceConflict([
      hit("a.md", "Address: 12 Baker St, London"),
      hit("b.md", "Address: 12 Baker St, Paris")
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.field).toBe("address");
    expect([conflicts[0]!.valueA, conflicts[0]!.valueB].sort()).toEqual(["12 Baker St, London", "12 Baker St, Paris"]);
  });

  it("flags a Korean comma-bearing 주소 conflict (the value spans the comma)", () => {
    const conflicts = detectSourceConflict([
      hit("a.md", "주소: 서울시 강남구, 역삼동"),
      hit("b.md", "주소: 서울시 강남구, 청담동")
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.field).toBe("주소");
  });

  it("does NOT flag a benign comma-LIST field that shares a first element — comma-broadening is gated to addresses only", () => {
    // The dominant false-positive class the gating prevents: a non-address list
    // value (items/tags/attendees) truncates at the first comma, exactly as before.
    expect(detectSourceConflict([hit("a.md", "items: milk, eggs"), hit("b.md", "items: milk, bread")])).toEqual([]);
    expect(detectSourceConflict([hit("a.md", "ingredients: flour, sugar"), hit("b.md", "ingredients: flour, salt")])).toEqual([]);
    expect(detectSourceConflict([hit("a.md", "attendees: Sam, Lee"), hit("b.md", "attendees: Sam, Kim")])).toEqual([]);
  });

  it("flags a Korean (Hangul-labelled) field conflict between two sources (H3 cross-lingual)", () => {
    const conflicts = detectSourceConflict([hit("addr-old.md", "주소: 서울"), hit("addr-new.md", "주소: 부산")]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.field).toBe("주소");
    expect([conflicts[0]!.valueA, conflicts[0]!.valueB].sort()).toEqual(["부산", "서울"]);
  });

  it("does NOT flag two Korean sources that AGREE on the same Hangul field (no false conflict)", () => {
    expect(detectSourceConflict([hit("a.md", "전화번호: 010-1234-5678"), hit("b.md", "전화번호:  010-1234-5678 ")])).toEqual([]);
  });

  it("does NOT flag a Korean prose prefix (참고:/메모: are not attributes)", () => {
    expect(detectSourceConflict([hit("a.md", "참고: 우산 챙기기"), hit("b.md", "참고: 물 마시기")])).toEqual([]);
  });

  it("does NOT flag two sources that AGREE on the same field (no false conflict)", () => {
    const a = hit("a.md", "Office address: 12 Baker Street");
    const b = hit("b.md", "office ADDRESS: 12 Baker Street");
    expect(detectSourceConflict([a, b])).toEqual([]);
  });

  it("ignores case/whitespace differences in the value (same fact, not a conflict)", () => {
    const a = hit("a.md", "Capital: Paris");
    const b = hit("b.md", "capital:  paris ");
    expect(detectSourceConflict([a, b])).toEqual([]);
  });

  it("ignores benign trailing punctuation in the value (5 vs 5. is not a conflict)", () => {
    expect(detectSourceConflict([hit("a.md", "count: 5"), hit("b.md", "count: 5.")])).toEqual([]);
    expect(detectSourceConflict([hit("a.md", "capital: Paris"), hit("b.md", "capital: Paris!")])).toEqual([]);
  });

  it("returns [] for unrelated hits (no shared labelled field)", () => {
    const a = hit("a.md", "The meeting is on Tuesday.");
    const b = hit("b.md", "Remember to water the plants.");
    expect(detectSourceConflict([a, b])).toEqual([]);
  });

  it("does NOT flag two differing values within the SAME hit (only cross-source conflicts)", () => {
    const a = hit("a.md", "port: 8080\nport: 9090");
    expect(detectSourceConflict([a])).toEqual([]);
  });

  it("returns [] for fewer than two hits", () => {
    expect(detectSourceConflict([])).toEqual([]);
    expect(detectSourceConflict([hit("a.md", "key: value")])).toEqual([]);
  });

  it("does NOT flag common prose prefixes with different following text (Note:/TODO:/Summary: are not attributes)", () => {
    expect(detectSourceConflict([
      hit("a.md", "Note: call the dentist"),
      hit("b.md", "note: water the plants")
    ])).toEqual([]);
    expect(detectSourceConflict([
      hit("a.md", "TODO: ship the release"),
      hit("b.md", "todo: review the PR")
    ])).toEqual([]);
  });

  it("does NOT parse a clock time as a labelled field (no garbage 'meeting at 9' conflict)", () => {
    expect(detectSourceConflict([
      hit("a.md", "Meeting at 9:30 with Sam"),
      hit("b.md", "Meeting at 9:45 with Sam")
    ])).toEqual([]);
  });
});

describe("formatSourceConflictWarning — user-facing surfacing of evidence conflicts", () => {
  it("renders a warning naming the field, both values, and both source refs", () => {
    const warning = formatSourceConflictWarning([
      hit("wifi-old.md", "WiFi password: hunter2"),
      hit("wifi-new.md", "wifi password: swordfish99")
    ]);
    expect(warning).toBeDefined();
    expect(warning).toContain("Your sources disagree");
    expect(warning).toContain("wifi password");
    expect(warning).toContain("hunter2");
    expect(warning).toContain("swordfish99");
    expect(warning).toContain("wifi-old.md");
    expect(warning).toContain("wifi-new.md");
  });

  it("returns undefined when sources agree (no warning rendered)", () => {
    expect(formatSourceConflictWarning([
      hit("a.md", "Capital: Paris"),
      hit("b.md", "capital: paris")
    ])).toBeUndefined();
  });
});

describe("groundingConflictCue — compose answer grounding (notes + episodes) into a cue", () => {
  it("warns when two grounded NOTES disagree on a field", () => {
    const cue = groundingConflictCue(
      [{ file: "wifi-old.md", text: "WiFi password: hunter2" }, { file: "wifi-new.md", text: "wifi password: swordfish99" }],
      []
    );
    expect(cue).toBeDefined();
    expect(cue).toContain("hunter2");
    expect(cue).toContain("swordfish99");
  });

  it("detects a conflict ACROSS a note and an episode (mixed grounding sources)", () => {
    const cue = groundingConflictCue(
      [{ file: "note.md", text: "Office floor: 3" }],
      [{ id: "ep-9", summary: "office floor: 7" }]
    );
    expect(cue).toBeDefined();
    expect(cue).toContain("office floor");
  });

  it("returns undefined when the grounding is consistent / empty", () => {
    expect(groundingConflictCue([{ file: "a.md", text: "Capital: Paris" }], [])).toBeUndefined();
    expect(groundingConflictCue([], [])).toBeUndefined();
  });

  it("detects a conflict ACROSS a remembered memory FACT and a note (the stale-memory grounded≠true hole)", () => {
    const cue = groundingConflictCue(
      [{ file: "team.md", text: "team lead: Sarah Chen" }],
      [],
      [{ key: "team lead", value: "Kim" }]
    );
    expect(cue).toBeDefined();
    expect(cue).toContain("team lead");
    expect(cue).toContain("Sarah Chen");
    expect(cue).toContain("Kim");
  });

  it("does NOT warn when a remembered fact AGREES with the grounded note (no false conflict)", () => {
    expect(groundingConflictCue(
      [{ file: "team.md", text: "team lead: Sarah Chen" }],
      [],
      [{ key: "team lead", value: "Sarah Chen" }]
    )).toBeUndefined();
  });

  it("a memory fact with a boolean-ish value (renders as topic only) is not a spurious conflict", () => {
    // renderMemoryFact drops a bare yes/true value → "allergy penicillin" (no colon),
    // so it carries no labelled field and cannot manufacture a conflict.
    expect(groundingConflictCue(
      [{ file: "n.md", text: "team lead: Sarah Chen" }],
      [],
      [{ key: "allergy_penicillin", value: "yes" }]
    )).toBeUndefined();
  });
});

describe("conflictCueFromMatches — chat-side cue from a flat grounding-match list", () => {
  it("flags two grounding matches that disagree on a field", () => {
    const cue = conflictCueFromMatches([
      { source: "wifi-old.md", text: "WiFi password: hunter2" },
      { source: "wifi-new.md", text: "wifi password: swordfish99" }
    ]);
    expect(cue).toBeDefined();
    expect(cue).toContain("hunter2");
    expect(cue).toContain("swordfish99");
  });

  it("returns undefined when the matches agree or there is only one", () => {
    expect(conflictCueFromMatches([
      { source: "a.md", text: "Capital: Paris" },
      { source: "b.md", text: "capital: paris" }
    ])).toBeUndefined();
    expect(conflictCueFromMatches([{ source: "a.md", text: "key: value" }])).toBeUndefined();
  });

  it("flags a remembered memory fact conflicting a grounded match (chat-path parity with ask)", () => {
    const cue = conflictCueFromMatches(
      [{ source: "team.md", text: "team lead: Sarah Chen" }],
      [{ key: "team lead", value: "Kim" }]
    );
    expect(cue).toBeDefined();
    expect(cue).toContain("Sarah Chen");
    expect(cue).toContain("Kim");
  });

  it("does NOT warn when the remembered fact AGREES with the grounded match", () => {
    expect(conflictCueFromMatches(
      [{ source: "team.md", text: "team lead: Sarah Chen" }],
      [{ key: "team lead", value: "Sarah Chen" }]
    )).toBeUndefined();
  });
});
