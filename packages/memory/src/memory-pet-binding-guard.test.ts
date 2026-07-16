import { describe, expect, it } from "vitest";

import { dropExistingPetBindingConflicts, resolvePetBindingCandidates } from "./memory-pet-binding-guard.js";

describe("resolvePetBindingCandidates — the 보리 incident, deterministically", () => {
  it("reproduces the production incident: a dog turn keeps only dog_name", () => {
    const extracted = {
      cat_name: "보리",
      dog_name: "보리",
      pet_cat_name: "보리",
      pet_dog_name: "보리",
      pet_names: "보리, 고양이"
    };
    const out = resolvePetBindingCandidates(extracted, "우리 강아지 보리 산책 시간 기억해줘");
    expect(out).toEqual({ dog_name: "보리", pet_names: "보리" });
  });

  it("keeps only cat_name when the turn is about a cat", () => {
    const out = resolvePetBindingCandidates({ cat_name: "나비", dog_name: "나비" }, "우리 고양이 나비가 요즘 살쪘어");
    expect(out).toEqual({ cat_name: "나비" });
  });

  it("drops BOTH species bindings when the turn supports neither (drop-not-guess)", () => {
    const out = resolvePetBindingCandidates({ cat_name: "보리", dog_name: "보리" }, "보리 밥 줬어?");
    expect(out).toEqual({});
  });

  it("drops both when the turn mentions both species (ambiguous)", () => {
    const out = resolvePetBindingCandidates({ cat_name: "보리", dog_name: "보리" }, "강아지랑 고양이 둘 다 키워, 보리라고 불러");
    expect(out).toEqual({});
  });

  it("keeps two DIFFERENT names on the two species keys", () => {
    const out = resolvePetBindingCandidates({ cat_name: "나비", dog_name: "보리" }, "강아지 보리랑 고양이 나비");
    expect(out).toEqual({ cat_name: "나비", dog_name: "보리" });
  });

  it("canonicalizes alias keys without losing the value", () => {
    const out = resolvePetBindingCandidates({ pet_dog_name: "보리" }, "강아지 보리");
    expect(out).toEqual({ dog_name: "보리" });
  });

  it("keeps the canonical key's value when an alias disagrees (never guesses)", () => {
    const out = resolvePetBindingCandidates({ dog_name: "보리", pet_dog_name: "초코" }, "강아지 보리");
    expect(out).toEqual({ dog_name: "보리" });
  });

  it("strips bare species words from pet_names and drops the key when empty", () => {
    expect(resolvePetBindingCandidates({ pet_names: "고양이" }, "고양이 키워")).toEqual({});
    expect(resolvePetBindingCandidates({ pet_names: "보리, 강아지" }, "강아지 보리")).toEqual({ pet_names: "보리" });
  });

  it("passes non-family keys through untouched", () => {
    const out = resolvePetBindingCandidates({ home_city: "부산", user_name: "진안" }, "나 부산 살아, 진안이야");
    expect(out).toEqual({ home_city: "부산", user_name: "진안" });
  });

  it("does not misread 개 inside an unrelated word as dog evidence", () => {
    // 소개/개발/날개 all contain 개 — the evidence regex requires a standalone
    // syllable, so this ambiguous turn drops both bindings instead of
    // fabricating a dog.
    const out = resolvePetBindingCandidates({ cat_name: "보리", dog_name: "보리" }, "개발 얘기하다가 보리 생각났어");
    expect(out).toEqual({});
  });
});

describe("dropExistingPetBindingConflicts — first binding wins until the user corrects", () => {
  it("drops a candidate that rebinds an existing value to another species", () => {
    const out = dropExistingPetBindingConflicts({ cat_name: "보리" }, { dog_name: "보리" });
    expect(out).toEqual({});
  });

  it("keeps a re-confirmation under the SAME key", () => {
    const out = dropExistingPetBindingConflicts({ dog_name: "보리" }, { dog_name: "보리" });
    expect(out).toEqual({ dog_name: "보리" });
  });

  it("recognizes alias keys in the existing store", () => {
    const out = dropExistingPetBindingConflicts({ cat_name: "보리" }, { pet_dog_name: "보리" });
    expect(out).toEqual({});
  });

  it("keeps a NEW name and non-family keys untouched", () => {
    const out = dropExistingPetBindingConflicts(
      { cat_name: "나비", home_city: "부산" },
      { dog_name: "보리" }
    );
    expect(out).toEqual({ cat_name: "나비", home_city: "부산" });
  });

  it("passes everything through when there is no existing memory", () => {
    const out = dropExistingPetBindingConflicts({ dog_name: "보리" }, undefined);
    expect(out).toEqual({ dog_name: "보리" });
  });
});
