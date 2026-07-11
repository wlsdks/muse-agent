import { describe, expect, it } from "vitest";

import { buildPersonaRaw, layerLabelKey, splitPersonaBody } from "./prompt-lab-logic.js";

describe("buildPersonaRaw", () => {
  it("renders no frontmatter fence when every field is empty", () => {
    expect(buildPersonaRaw({ language: "", maxWords: "", register: "" }, "Be warm.")).toBe("Be warm.\n");
  });

  it("renders a frontmatter fence with only the non-empty fields, register/maxWords/language order", () => {
    expect(buildPersonaRaw({ language: "한국어", maxWords: "120", register: "반말" }, "Be playful.")).toBe(
      "---\nregister: 반말\nmaxWords: 120\nlanguage: 한국어\n---\n\nBe playful.\n"
    );
  });

  it("omits an unset field from the fence but keeps the ones that are set", () => {
    expect(buildPersonaRaw({ language: "", maxWords: "50", register: "" }, "Stay dry.")).toBe(
      "---\nmaxWords: 50\n---\n\nStay dry.\n"
    );
  });
});

describe("splitPersonaBody", () => {
  it("strips a well-formed frontmatter fence, leaving only the body", () => {
    expect(splitPersonaBody("---\nregister: 반말\n---\n\nBe playful.")).toBe("Be playful.");
  });

  it("returns the whole text when there is no fence", () => {
    expect(splitPersonaBody("Just be nice.")).toBe("Just be nice.");
  });
});

describe("layerLabelKey", () => {
  it("maps identity-core and personality exactly", () => {
    expect(layerLabelKey("identity-core")).toBe("pl.preview.layer.identity-core");
    expect(layerLabelKey("personality")).toBe("pl.preview.layer.personality");
  });

  it("maps any surface-role:<surface> id by prefix", () => {
    expect(layerLabelKey("surface-role:chat")).toBe("pl.preview.layer.surface-role");
    expect(layerLabelKey("surface-role:ask")).toBe("pl.preview.layer.surface-role");
  });

  it("returns undefined for an unrecognized layer id", () => {
    expect(layerLabelKey("something-new")).toBeUndefined();
  });
});
