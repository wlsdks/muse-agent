import type { JsonObject } from "@muse/shared";

import type { MuseTool } from "./index.js";

/**
 * `unit_convert` — deterministic physical-unit conversion (length / mass /
 * volume / temperature). The local model knows approximate factors but rounds
 * and occasionally inverts them; a tool with EXACT factors is the grounded
 * answer ("5 mi = 8.04672 km", not "≈8 km"). Distinct from `math_eval`
 * (arithmetic over operators) and the web search tool (live data like currency).
 */

// Factor to the category's base unit (metre / gram / litre). Temperature is NOT
// here — it needs an offset, handled separately.
const LENGTH: Record<string, number> = { m: 1, km: 1000, cm: 0.01, mm: 0.001, um: 1e-6, nm: 1e-9, mi: 1609.344, yd: 0.9144, ft: 0.3048, in: 0.0254, nmi: 1852 };
const MASS: Record<string, number> = { g: 1, kg: 1000, mg: 0.001, t: 1_000_000, lb: 453.59237, oz: 28.349523125, st: 6350.29318 };
const VOLUME: Record<string, number> = { l: 1, ml: 0.001, kl: 1000, gal: 3.785411784, qt: 0.946352946, pt: 0.473176473, cup: 0.2365882365, floz: 0.0295735295625, tbsp: 0.01478676478, tsp: 0.00492892159 };

const CATEGORIES: ReadonlyArray<Record<string, number>> = [LENGTH, MASS, VOLUME];
const TEMPERATURE = new Set(["c", "f", "k"]);

const UNIT_ALIASES: Record<string, string> = {
  metre: "m", metres: "m", meter: "m", meters: "m",
  kilometre: "km", kilometres: "km", kilometer: "km", kilometers: "km",
  centimetre: "cm", centimetres: "cm", centimeter: "cm", centimeters: "cm",
  millimetre: "mm", millimetres: "mm", millimeter: "mm", millimeters: "mm",
  mile: "mi", miles: "mi", yard: "yd", yards: "yd", foot: "ft", feet: "ft",
  inch: "in", inches: "in", "nautical mile": "nmi",
  gram: "g", grams: "g", gramme: "g", grammes: "g", kilogram: "kg", kilograms: "kg", kilo: "kg", kilos: "kg",
  milligram: "mg", milligrams: "mg", tonne: "t", tonnes: "t", "metric ton": "t",
  pound: "lb", pounds: "lb", lbs: "lb", ounce: "oz", ounces: "oz", stone: "st",
  litre: "l", litres: "l", liter: "l", liters: "l", millilitre: "ml", millilitres: "ml", milliliter: "ml", milliliters: "ml",
  gallon: "gal", gallons: "gal", quart: "qt", quarts: "qt", pint: "pt", pints: "pt",
  cups: "cup", "fluid ounce": "floz", "fluid ounces": "floz", tablespoon: "tbsp", tablespoons: "tbsp", teaspoon: "tsp", teaspoons: "tsp",
  celsius: "c", centigrade: "c", "°c": "c", fahrenheit: "f", "°f": "f", kelvin: "k", "°k": "k"
};

function normalizeUnit(raw: string): string {
  const k = raw.trim().toLowerCase().replace(/\.$/u, "");
  return UNIT_ALIASES[k] ?? k;
}

const toCelsius = (v: number, u: string): number => (u === "c" ? v : u === "f" ? (v - 32) * 5 / 9 : v - 273.15);
const fromCelsius = (c: number, u: string): number => (u === "c" ? c : u === "f" ? c * 9 / 5 + 32 : c + 273.15);

const isKnown = (u: string): boolean => TEMPERATURE.has(u) || CATEGORIES.some((cat) => u in cat);

/**
 * Convert `value` from one unit to another within the same category. Temperature
 * uses the offset formula; length/mass/volume scale by exact factors. Throws on
 * an unknown unit or a cross-category conversion (the caller maps that to an error).
 */
export function convertUnit(value: number, from: string, to: string): number {
  const f = normalizeUnit(from);
  const t = normalizeUnit(to);
  if (TEMPERATURE.has(f) || TEMPERATURE.has(t)) {
    if (!(TEMPERATURE.has(f) && TEMPERATURE.has(t))) {
      throw new Error(`cannot convert between a temperature and a non-temperature unit ('${from}' → '${to}')`);
    }
    return fromCelsius(toCelsius(value, f), t);
  }
  for (const cat of CATEGORIES) {
    if (f in cat && t in cat) return value * cat[f]! / cat[t]!;
  }
  if (!isKnown(f)) throw new Error(`unknown unit '${from}'`);
  if (!isKnown(t)) throw new Error(`unknown unit '${to}'`);
  throw new Error(`cannot convert '${from}' to '${to}' — they are different kinds of unit`);
}

export function createUnitConvertTool(): MuseTool {
  return {
    definition: {
      description:
        "Converts a quantity between physical units of the SAME kind — length (m, km, cm, mi, ft, in, yd), mass (g, kg, lb, oz, t), volume (l, ml, gal, cup, floz, tbsp, tsp), or temperature (c, f, k). Returns the EXACT converted value (e.g. 5 mi = 8.04672 km). USE WHEN the user asks to convert a measurement ('how many km is 5 miles?', '섭씨 20도는 화씨로?', 'convert 2 cups to ml'). Do NOT use for an arithmetic expression with operators (use math_eval) or for live/market data like CURRENCY exchange rates (use the web search tool — this tool only does fixed physical units).",
      domain: "core",
      inputSchema: {
        additionalProperties: false,
        properties: {
          from: { description: "Source unit, e.g. 'mi', 'kg', 'celsius'.", type: "string" },
          to: { description: "Target unit of the SAME kind, e.g. 'km', 'lb', 'fahrenheit'.", type: "string" },
          value: { description: "The numeric quantity to convert, e.g. 5.", type: "number" }
        },
        required: ["value", "from", "to"],
        type: "object"
      },
      keywords: ["convert", "unit", "miles", "km", "celsius", "fahrenheit", "kg", "pounds", "변환", "환산", "단위", "섭씨", "화씨"],
      name: "unit_convert",
      risk: "read"
    },
    execute: (args): JsonObject => {
      const rawValue = args["value"];
      const value = typeof rawValue === "number" && Number.isFinite(rawValue) ? rawValue : Number.NaN;
      const from = typeof args["from"] === "string" ? args["from"] : "";
      const to = typeof args["to"] === "string" ? args["to"] : "";
      if (!Number.isFinite(value)) return { error: "value must be a finite number" };
      if (from.length === 0 || to.length === 0) return { error: "both 'from' and 'to' units are required" };
      try {
        const result = convertUnit(value, from, to);
        return { from, to, value: result };
      } catch (error) {
        return { error: error instanceof Error ? error.message : "conversion failed" };
      }
    }
  };
}
