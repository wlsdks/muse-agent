import { describe, expect, it } from "vitest";

import { convertNumberBase, createNumberBaseTool } from "./muse-tools-number-base.js";

describe("convertNumberBase (radix conversion, BigInt-exact)", () => {
  it("converts between the four common bases", () => {
    expect(convertNumberBase("255", "decimal", "hex")).toMatchObject({ result: "ff", decimal: "255" });
    expect(convertNumberBase("ff", "hex", "decimal")).toMatchObject({ result: "255" });
    expect(convertNumberBase("1010", "binary", "decimal")).toMatchObject({ result: "10" });
    expect(convertNumberBase("777", "octal", "decimal")).toMatchObject({ result: "511" });
  });

  it("strips a 0x/0b/0o prefix and handles a negative sign", () => {
    expect(convertNumberBase("0xff", "hex", "decimal")).toMatchObject({ result: "255" });
    expect(convertNumberBase("-10", "decimal", "hex")).toMatchObject({ result: "-a" });
  });

  it("is EXACT past Number precision (BigInt) — the whole point of grounding it", () => {
    expect(convertNumberBase("DEADBEEFCAFE1234", "hex", "decimal")).toMatchObject({ result: "16045690984503054900" });
  });

  it("returns undefined for a digit not valid in the source base", () => {
    expect(convertNumberBase("2", "binary", "hex")).toBeUndefined();
    expect(convertNumberBase("xyz", "decimal", "hex")).toBeUndefined();
    expect(convertNumberBase("", "decimal", "hex")).toBeUndefined();
  });
});

describe("createNumberBaseTool", () => {
  it("is a read tool named number_base", () => {
    const tool = createNumberBaseTool();
    expect(tool.definition.name).toBe("number_base");
    expect(tool.definition.risk).toBe("read");
  });

  it("converts via execute, returning the target representation + decimal", () => {
    const out = createNumberBaseTool().execute({ value: "255", from: "decimal", to: "hex" }, { runId: "r", userId: "u" }) as { result: string; decimal: string };
    expect(out.result).toBe("ff");
    expect(out.decimal).toBe("255");
  });

  it("returns an error (never throws) for an invalid digit or unknown base", () => {
    const tool = createNumberBaseTool();
    expect(tool.execute({ value: "2", from: "binary", to: "hex" }, { runId: "r", userId: "u" })).toHaveProperty("error");
    expect(tool.execute({ value: "10", from: "decimal", to: "base99" }, { runId: "r", userId: "u" })).toHaveProperty("error");
  });
});
