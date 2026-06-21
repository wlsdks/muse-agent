import type { JsonObject, JsonValue } from "@muse/shared";
import type { ModelProvider } from "@muse/model";

/**
 * Grounded vision extraction — read an IMAGE and return STRUCTURED data, the
 * foundation of "grounded vision actions" (snap a receipt / flyer / business
 * card → structured facts → a draft-first calendar/task/note write). Uses the
 * model's native structured output (`responseFormat` → Ollama `format`) at
 * temperature 0 so the extraction is constrained + deterministic, and carries
 * the image as an inline attachment (the Ollama adapter forwards it to gemma4's
 * vision via per-message `images`).
 *
 * GROUNDING FLOOR applied to vision: the system instruction forbids inventing a
 * field that isn't visible — an unreadable / absent field is OMITTED, never
 * guessed. The image is the only evidence; this keeps fabrication=0 on the
 * vision surface (a downstream actuator then confirms draft-first before any
 * write). The caller validates/uses the returned object.
 */
export interface VisionExtractInput {
  readonly model: string;
  /** Base64 image bytes (no data: prefix). */
  readonly imageBase64: string;
  /** MIME type, e.g. "image/png", "image/jpeg". */
  readonly mimeType: string;
  /** JSON Schema the extraction must conform to (native constrained decoding). */
  readonly schema: JsonObject;
  /** What to extract, e.g. "Extract the merchant, total, and date from this receipt." */
  readonly instruction: string;
}

export interface VisionExtractResult {
  /** True when the model returned a parseable JSON object. */
  readonly ok: boolean;
  /** The parsed object (present only when ok). */
  readonly data?: JsonObject;
  /** Raw model output (always present — for tracing / a failed parse). */
  readonly raw: string;
  /** Why extraction failed (present only when !ok). */
  readonly error?: string;
}

const EXTRACT_SYSTEM_PROMPT =
  "You are a precise visual extractor. Read ONLY what is actually visible in the image and return a single JSON object matching the requested schema. " +
  "If a field is not clearly visible in the image, OMIT it entirely — never guess, infer, or invent a value. The image is your only source. Output JSON only, no prose.";

/**
 * Schema-required gate over an extracted object. Every name in `schema.required`
 * must be PRESENT and a non-empty string (mirrors the `str()` discipline the
 * routing layer uses), and any property declared `type: "string"` whose value is
 * a non-string is a violation too. Conservative: enforces ONLY what the schema
 * declares — an absent schema or absent `required` returns ok (back-compat, so a
 * legit extraction whose schema declares no requireds is never newly failed).
 *
 * This is the no-partial-result floor (AppWorld): a hollow `{}` or a
 * required:["merchant"] receipt with no merchant fails CLOSED at the source
 * rather than masquerading as a successful extraction downstream.
 */
export function validateExtraction(
  data: JsonObject,
  schema: JsonObject | undefined
): { ok: true } | { ok: false; missing: string[] } {
  if (!schema) {
    return { ok: true };
  }
  const isNonEmptyString = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;
  const missing: string[] = [];
  const required = Array.isArray(schema.required) ? (schema.required as JsonValue[]) : [];
  for (const name of required) {
    if (typeof name === "string" && !isNonEmptyString(data[name])) {
      missing.push(name);
    }
  }
  const properties = schema.properties;
  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    for (const [name, spec] of Object.entries(properties)) {
      if (missing.includes(name) || !(name in data)) {
        continue;
      }
      const declaresString = spec && typeof spec === "object" && !Array.isArray(spec) && (spec as JsonObject).type === "string";
      if (declaresString && typeof data[name] !== "string") {
        missing.push(name);
      }
    }
  }
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

/**
 * Run a structured extraction over an image. Fail-soft: a non-JSON / non-object
 * model output (or any generate error) returns `{ ok: false }` with the raw text
 * and a reason — it never throws, so a caller can degrade to "couldn't read it"
 * instead of crashing.
 */
export async function extractStructuredFromImage(
  provider: ModelProvider,
  input: VisionExtractInput
): Promise<VisionExtractResult> {
  let raw = "";
  try {
    const response = await provider.generate({
      maxOutputTokens: 512,
      messages: [
        { content: EXTRACT_SYSTEM_PROMPT, role: "system" },
        {
          attachments: [{ dataBase64: input.imageBase64, mimeType: input.mimeType }],
          content: input.instruction,
          role: "user"
        }
      ],
      model: input.model,
      responseFormat: input.schema,
      temperature: 0
    });
    raw = response.output ?? "";
  } catch (cause) {
    return { error: `vision extraction failed: ${cause instanceof Error ? cause.message : String(cause)}`, ok: false, raw };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return { error: "extraction output was not valid JSON", ok: false, raw };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { error: "extraction output was not a JSON object", ok: false, raw };
  }
  const validation = validateExtraction(parsed as JsonObject, input.schema);
  if (!validation.ok) {
    return { error: `extraction omitted required field(s): ${validation.missing.join(", ")}`, ok: false, raw };
  }
  return { data: parsed as JsonObject, ok: true, raw };
}

export interface VisionDescribeInput {
  readonly imageBase64: string;
  readonly mimeType: string;
  readonly model: string;
  /** Optional focus, e.g. "what does the error dialog say?" */
  readonly question?: string;
}

export interface VisionDescribeResult {
  readonly ok: boolean;
  readonly text?: string;
  readonly error?: string;
}

const DESCRIBE_SYSTEM_PROMPT =
  "You describe images for the user. State ONLY what is actually visible — concrete apps, windows, text, " +
  "and content you can read. Quote on-screen text exactly where it matters. If something is unclear or " +
  "cut off, say so — never guess, infer, or invent. Keep it to a few sentences.";

/**
 * Free-text description of an image (the screen-read primitive). Fail-soft
 * like `extractStructuredFromImage`: a generate error or blank output returns
 * `{ ok: false }` with a reason — never a throw, never an invented description.
 */
export async function describeImage(
  provider: ModelProvider,
  input: VisionDescribeInput
): Promise<VisionDescribeResult> {
  let text: string;
  try {
    const response = await provider.generate({
      maxOutputTokens: 400,
      messages: [
        { content: DESCRIBE_SYSTEM_PROMPT, role: "system" },
        {
          attachments: [{ dataBase64: input.imageBase64, mimeType: input.mimeType }],
          content: input.question?.trim() ? `Describe what is visible, focusing on: ${input.question.trim()}` : "Describe what is visible in this image.",
          role: "user"
        }
      ],
      model: input.model,
      temperature: 0
    });
    text = (response.output ?? "").trim();
  } catch (cause) {
    return { error: `vision description failed: ${cause instanceof Error ? cause.message : String(cause)}`, ok: false };
  }
  if (text.length === 0) {
    return { error: "the vision model returned no description", ok: false };
  }
  return { ok: true, text };
}
