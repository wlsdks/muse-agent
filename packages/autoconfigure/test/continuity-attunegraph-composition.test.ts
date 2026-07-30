import { expect, it } from "vitest";

import {
  createConfiguredContinuityAttuneGraphProjector
} from "../src/continuity-attunegraph-composition.js";

it("keeps absent and exactly empty AttuneGraph configuration disabled", () => {
  expect(createConfiguredContinuityAttuneGraphProjector({})).toBeUndefined();
  expect(createConfiguredContinuityAttuneGraphProjector({
    MUSE_ATTUNEGRAPH_DATABASE: ""
  })).toBeUndefined();
});

it("creates only an explicit absolute projector and fails invalid non-empty configuration closed", () => {
  expect(createConfiguredContinuityAttuneGraphProjector({
    MUSE_ATTUNEGRAPH_DATABASE: "/tmp/muse-attunegraph.sqlite"
  })).toMatchObject({ project: expect.any(Function) });
  expect(() =>
    createConfiguredContinuityAttuneGraphProjector({
      MUSE_ATTUNEGRAPH_DATABASE: " "
    })
  ).toThrow(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));
  expect(() =>
    createConfiguredContinuityAttuneGraphProjector({
      MUSE_ATTUNEGRAPH_DATABASE: "relative.sqlite"
    })
  ).toThrow(expect.objectContaining({ code: "INVALID_CONFIGURATION" }));
});
