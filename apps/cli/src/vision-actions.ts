import { describeImage, extractStructuredFromImage } from "@muse/agent-core";
import type { JsonObject, JsonValue } from "@muse/shared";
import type { ModelProvider } from "@muse/model";

/**
 * Autonomous grounded vision routing (`muse ask --image --auto`): in ONE
 * grounded extraction, gemma4 classifies the image (event / receipt / contact /
 * other) AND pulls the fields for that kind, so a single photo routes to the
 * right draft-first action — calendar event, expense note, or new contact. The
 * grounding floor still holds (the primitive omits any field not visible, never
 * invents), and the caller stays draft-first (show the draft, write only on
 * --apply).
 */
type VisionActionKind = "event" | "receipt" | "contact" | "document" | "other";

export interface VisionAction {
  readonly kind: VisionActionKind;
  /** The extracted fields relevant to `kind` (only the visible ones). */
  readonly fields: JsonObject;
  /** Human-readable draft shown before any write. */
  readonly draftText: string;
  /** The actuator route, or "none" for `other`. */
  readonly route: "calendar" | "note" | "contact" | "none";
  /**
   * Extracted field names that could NOT be confirmed against an independent
   * transcription of the image (the grounding gate). A hallucinated value
   * surfaces here; the caller refuses to auto-apply while this is non-empty
   * (deterministic fabrication guard, not a prompt please-don't-invent).
   */
  readonly unverified: readonly string[];
}

const CLASSIFY_SCHEMA: JsonObject = {
  properties: { kind: { enum: ["event", "receipt", "contact", "document", "other"], type: "string" } },
  required: ["kind"],
  type: "object"
};
const CLASSIFY_INSTRUCTION =
  "Classify this image as exactly one kind: 'event' (a flyer/poster/invite with a date and time), " +
  "'receipt' (a purchase receipt or bill), 'contact' (a business card or someone's contact details), " +
  "'document' (a page of text, notes, a whiteboard, or an article worth keeping), or 'other'. " +
  "Return only the kind.";

// Per-kind FOCUSED schemas — a small, single-purpose schema extracts far more
// reliably on a local model than one wide all-kinds schema (proven by the
// --extract / --to-calendar paths). Each runs only after the image is classified.
const KIND_EXTRACT: Record<"event" | "receipt" | "contact" | "document", { schema: JsonObject; instruction: string }> = {
  document: {
    instruction: "Extract a short descriptive title for this document and its main text content (body), transcribing what is written. Omit a field only if there is genuinely no text.",
    schema: { properties: { body: { type: "string" }, title: { type: "string" } }, required: ["title", "body"], type: "object" }
  },
  contact: {
    instruction: "Extract this person's contact details: name, email, phone, and how they relate to the user (relationship, e.g. 'dentist') if stated. Omit any field not visible.",
    schema: { properties: { email: { type: "string" }, name: { type: "string" }, phone: { type: "string" }, relationship: { type: "string" } }, required: ["name"], type: "object" }
  },
  event: {
    instruction: "Extract the calendar event: title, startsAt (the date/time copied EXACTLY as shown), location, and notes. Omit any field not visible.",
    schema: { properties: { location: { type: "string" }, notes: { type: "string" }, startsAt: { type: "string" }, title: { type: "string" } }, required: ["title", "startsAt"], type: "object" }
  },
  receipt: {
    instruction: "Extract the receipt: merchant name, total amount, and date. Omit any field not visible.",
    schema: { properties: { date: { type: "string" }, merchant: { type: "string" }, total: { type: "string" } }, required: ["merchant"], type: "object" }
  }
};

// Per-kind REQUIRED field names, DERIVED from the same KIND_EXTRACT schemas the
// extraction uses — a single source, so the blocking/droppable split can never
// diverge from what the schema (and route gate) actually demands.
const REQUIRED_FIELDS: Record<VisionActionKind, ReadonlySet<string>> = {
  contact: new Set((KIND_EXTRACT.contact.schema.required as string[] | undefined) ?? []),
  document: new Set((KIND_EXTRACT.document.schema.required as string[] | undefined) ?? []),
  event: new Set((KIND_EXTRACT.event.schema.required as string[] | undefined) ?? []),
  other: new Set<string>(),
  receipt: new Set((KIND_EXTRACT.receipt.schema.required as string[] | undefined) ?? [])
};

/**
 * Partition a gated action's `unverified` fields into REQUIRED (blocking) vs
 * OPTIONAL (droppable). A required field that couldn't be grounded blocks the
 * WHOLE action (the grounded core is meaningless without it). An un-grounded
 * OPTIONAL field is droppable — the caller strips it and applies the grounded
 * core, so a hallucinated `date` never blocks a grounded `merchant`+`total`.
 * Fabrication floor: a droppable field is DROPPED (never persisted), not kept.
 */
export function splitUnverified(action: VisionAction): { droppable: string[]; blocking: string[] } {
  const required = REQUIRED_FIELDS[action.kind];
  const blocking: string[] = [];
  const droppable: string[] = [];
  for (const name of action.unverified) {
    (required.has(name) ? blocking : droppable).push(name);
  }
  return { blocking, droppable };
}

/**
 * Strip un-grounded OPTIONAL field(s) and RECOMPOSE the action deterministically
 * by re-shaping the surviving fields through `shapeVisionAction` — so any DERIVED
 * string (the receipt `note`, the document `note`/`path`, the draft text) is
 * rebuilt WITHOUT the dropped value, guaranteeing it can never leak into the
 * persisted output. Re-gates so `unverified` reflects only the survivors.
 */
export function dropUnverifiedOptional(action: VisionAction, droppable: readonly string[]): VisionAction {
  if (droppable.length === 0) {
    return action;
  }
  const drop = new Set(droppable);
  const surviving: Record<string, JsonValue> = { kind: action.kind };
  for (const [name, value] of Object.entries(action.fields)) {
    if (!drop.has(name) && !DERIVED_FIELDS.has(name)) {
      surviving[name] = value;
    }
  }
  const reshaped = shapeVisionAction(surviving);
  return { ...reshaped, unverified: action.unverified.filter((name) => !drop.has(name)) };
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined);

const EVIDENCE_INSTRUCTION =
  "Transcribe EVERY piece of text, every number, name, date, time, and amount visible in this image, " +
  "exactly as written. Do not summarize or interpret — just list what is literally printed.";

// Fields that are DERIVED from extracted ones (composed strings / a slug),
// not separately read from the image — grounding the source fields covers them.
const DERIVED_FIELDS: ReadonlySet<string> = new Set(["note", "path"]);

/** Maximal digit-runs (length ≥ 2) in `text`, with thousands separators inside a
 *  number removed so "123,450" → one run "123450". */
function digitRuns(text: string): Set<string> {
  const joined = text.replace(/(\d)[,_ ](?=\d{3}\b)/gu, "$1");
  return new Set(joined.match(/\d{2,}/gu) ?? []);
}

/** Word/entity tokens: latin alphanumerics (len ≥ 2) + individual CJK chars. */
function wordTokens(text: string): string[] {
  const lower = text.toLowerCase();
  return [...(lower.match(/[a-z0-9]{2,}/gu) ?? []), ...(lower.match(/[㐀-鿿가-힯]/gu) ?? [])];
}

/** A non-digit identifying token: a latin run with at least one letter, or a CJK
 *  char. A pure digit-run ("50", "12") is NOT one — it carries no field identity,
 *  so it can't anchor grounding on its own. */
function hasTextToken(value: string): boolean {
  return /[a-z]/iu.test(value) || /[㐀-鿿가-힯]/u.test(value);
}

// Field NAMES whose value is a monetary amount (the only numeric-amount field in
// any KIND_EXTRACT schema is the receipt `total`). An amount-role field grounds
// only on a digit-run that sits in the evidence ADJACENT to a currency/amount
// marker — closing the year-coincidence leak ("$2026" matching a "2026" year)
// without false-dropping a real small total ("$40" next to "$").
const AMOUNT_FIELD_NAMES: ReadonlySet<string> = new Set(["total"]);

/** Currency / amount markers that anchor an amount run: a symbol, an ISO code,
 *  or an amount word. Matched case-insensitively. */
const AMOUNT_MARKER = /[$₩€£¥]|\b(?:krw|usd|eur|gbp|jpy|total|subtotal|amount|due|paid|balance)\b/giu;

/** Is a digit-run from `value` present in `evidence` ADJACENT (within ~2 chars)
 *  to a currency/amount marker? Anchors an amount field so a bare coincidental
 *  run (a year, a row number) cannot ground a hallucinated total, while a real
 *  small total next to a `$`/`total` marker still does. Thousands separators in
 *  the evidence are normalized so "12,400" matches the run "12400". */
function amountRunIsAnchored(value: string, evidence: string): boolean {
  const joinedEv = evidence.replace(/(\d)[,_ ](?=\d{3}\b)/gu, "$1");
  const runs = [...digitRuns(value)];
  if (runs.length === 0) {
    return false;
  }
  for (const run of runs) {
    const runRe = new RegExp(`(?<!\\d)${run}(?!\\d)`, "gu");
    let m: RegExpExecArray | null;
    while ((m = runRe.exec(joinedEv)) !== null) {
      const winStart = Math.max(0, m.index - 8);
      const winEnd = Math.min(joinedEv.length, m.index + run.length + 8);
      const window = joinedEv.slice(winStart, winEnd);
      const runStartInWindow = m.index - winStart;
      AMOUNT_MARKER.lastIndex = 0;
      let mk: RegExpExecArray | null;
      while ((mk = AMOUNT_MARKER.exec(window)) !== null) {
        const gapBefore = runStartInWindow - (mk.index + mk[0].length);
        const gapAfter = mk.index - (runStartInWindow + run.length);
        if ((gapBefore >= 0 && gapBefore <= 2) || (gapAfter >= 0 && gapAfter <= 2)) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Is `value` grounded in the image `evidence` transcription? Tolerant by design
 * so a faithfully-extracted field is NOT false-dropped:
 *  - digit fields: every digit-run of length ≥ 4 (year / amount / phone block)
 *    must appear — SHORT runs (a worded-month's day/month: "June 7" ⇒ "2026-06-07"
 *    grounds on the year 2026 alone) and a country-code prefix are NOT required;
 *  - if only short digit-runs exist, the longest must appear, else fall to words;
 *  - text fields: a majority of the value's word/entity tokens must be visible.
 * A hallucinated value (absent from the evidence) matches none of these → false.
 *
 * Weak-numeric guard (fabrication-floor): a value whose ONLY signal is a SHORT
 * digit-run (longest contiguous run ≤ 3) and that carries NO non-digit text/CJK
 * token of its own ("50", "12") is NOT groundable on a bare coincidental digit
 * match (a discount %, a clock time, an address fragment) — it has no field
 * identity to anchor. Such a value fails CLOSED here (→ recorded unverified). The
 * guard can only make the gate STRICTER; ≥4-digit runs and any text/CJK value are
 * unaffected.
 *
 * Amount-role anchoring: when `name` is an amount field (receipt `total`), the
 * value's digit-run must appear in the evidence ADJACENT to a currency/amount
 * marker — "$40" grounds (next to "$"), a hallucinated "$2026" does NOT (its
 * 2026 run sits next to "Concert"/"Hall", a year not an amount). This is STRICTLY
 * a re-classification of amount fields: `name` is OPTIONAL and absent reproduces
 * today's behavior exactly; non-amount names take the unchanged text/date path.
 */
export function fieldIsGrounded(value: string, evidence: string, name?: string): boolean {
  if (name !== undefined && AMOUNT_FIELD_NAMES.has(name)) {
    return amountRunIsAnchored(value, evidence);
  }
  const ev = evidence.toLowerCase();
  const evDigits = digitRuns(evidence);
  const valDigits = [...digitRuns(value)];
  const significant = valDigits.filter((d) => d.length >= 4);
  if (significant.length > 0) {
    return significant.every((d) => evDigits.has(d));
  }
  const weakNumericOnly = !hasTextToken(value);
  if (valDigits.length > 0 && !weakNumericOnly) {
    const longest = valDigits.reduce((a, b) => (b.length > a.length ? b : a));
    if (evDigits.has(longest)) {
      return true;
    }
  }
  if (weakNumericOnly) {
    return false;
  }
  const tokens = wordTokens(value);
  if (tokens.length === 0) {
    return false;
  }
  const hits = tokens.filter((token) => ev.includes(token)).length;
  return hits / tokens.length >= 0.5;
}

function annotateUnverified(draftText: string, unverified: readonly string[]): string {
  if (unverified.length === 0) {
    return draftText;
  }
  return `${draftText}\n  ⚠ unverified (not confirmed visible in the image — check before applying): ${unverified.join(", ")}`;
}

/**
 * The grounding gate over a shaped action. Each extracted field value must be
 * confirmable against an INDEPENDENT transcription of the image; one that isn't
 * is recorded in `unverified` and flagged in the draft. Empty/failed evidence
 * fails CLOSED — every field is unverified (mirrors the text path, where empty
 * evidence is a fail-close, never a fail-open pass).
 */
export function gateVisionAction(action: VisionAction, evidence: string | undefined): VisionAction {
  if (action.route === "none") {
    return { ...action, unverified: [] };
  }
  const fieldNames = Object.keys(action.fields).filter((name) => !DERIVED_FIELDS.has(name));
  const evidenceText = evidence?.trim() ?? "";
  const unverified = evidenceText.length === 0
    ? fieldNames
    : fieldNames.filter((name) => {
        const value = action.fields[name];
        return typeof value === "string" && value.trim().length > 0 && !fieldIsGrounded(value, evidenceText, name);
      });
  return { ...action, draftText: annotateUnverified(action.draftText, unverified), unverified };
}

/**
 * Normalize an extracted `startsAt` for the calendar actuator. The model returns
 * the date EXACTLY as printed (e.g. "July 18, 2026, 8:00 PM") — and the calendar
 * parser accepts ISO-8601 or a relative phrase but not every absolute format. So
 * when (and only when) the string is an absolute date JS can parse, convert it to
 * ISO **in code** (deterministic, uses the local TZ) — never ask the model to
 * compute the timestamp (it gets weekday/TZ wrong). A relative phrase ("tomorrow
 * 3pm", "내일 오후 3시") isn't JS-parseable, so it passes through unchanged for the
 * calendar's own natural-language resolver.
 */
export function normalizeStartsAt(value: string): string {
  const t = value.trim();
  // Already ISO-ish — leave it.
  if (/^\d{4}-\d{2}-\d{2}/u.test(t)) return t;
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? t : new Date(ms).toISOString();
}

/** Classify the image, then run a kind-specific focused extraction, and shape a
 *  draft-first action. Two grounded calls (classify → extract) — more reliable on
 *  a local model than one wide schema. Returns route "none" when it can't
 *  confidently route; the caller falls back to a plain description. */
export async function classifyVisionAction(
  provider: ModelProvider,
  input: { readonly model: string; readonly imageBase64: string; readonly mimeType: string }
): Promise<VisionAction | { readonly ok: false; readonly error: string }> {
  const cls = await extractStructuredFromImage(provider, {
    imageBase64: input.imageBase64,
    instruction: CLASSIFY_INSTRUCTION,
    mimeType: input.mimeType,
    model: input.model,
    schema: CLASSIFY_SCHEMA
  });
  if (!cls.ok || !cls.data) {
    return { error: cls.error ?? "could not read the image", ok: false };
  }
  const kind = cls.data.kind;
  if (kind !== "event" && kind !== "receipt" && kind !== "contact" && kind !== "document") {
    return shapeVisionAction({ kind: "other" });
  }
  const ex = await extractStructuredFromImage(provider, {
    imageBase64: input.imageBase64,
    instruction: KIND_EXTRACT[kind].instruction,
    mimeType: input.mimeType,
    model: input.model,
    schema: KIND_EXTRACT[kind].schema
  });
  if (!ex.ok || !ex.data) {
    return { error: ex.error ?? `could not extract ${kind} fields`, ok: false };
  }
  // Independent evidence pass: a raw transcription the extracted fields must be
  // grounded in. A separate call (not the extraction's own output) so a
  // hallucinated field has nothing to hide behind; empty evidence fails closed.
  const evidence = await describeImage(provider, {
    imageBase64: input.imageBase64,
    mimeType: input.mimeType,
    model: input.model,
    question: EVIDENCE_INSTRUCTION
  });
  return gateVisionAction(shapeVisionAction({ kind, ...ex.data }), evidence.ok ? evidence.text : undefined);
}

/** Pure shaping of an extracted object into a routed, draft-first action — split
 *  out so it's unit-testable without a model. */
export function shapeVisionAction(data: JsonObject): VisionAction {
  const kind = data.kind === "event" || data.kind === "receipt" || data.kind === "contact" || data.kind === "document" ? data.kind : "other";
  if (kind === "event" && str(data.title) && str(data.startsAt)) {
    const f = { title: str(data.title)!, startsAt: str(data.startsAt)!, ...(str(data.location) ? { location: str(data.location)! } : {}), ...(str(data.notes) ? { notes: str(data.notes)! } : {}) };
    return { draftText: `📅 Calendar event:\n  title: ${f.title}\n  startsAt: ${f.startsAt}${f.location ? `\n  location: ${f.location}` : ""}${f.notes ? `\n  notes: ${f.notes}` : ""}`, fields: f, kind, route: "calendar", unverified: [] };
  }
  if (kind === "receipt" && (str(data.merchant) || str(data.total))) {
    const f = { ...(str(data.merchant) ? { merchant: str(data.merchant)! } : {}), ...(str(data.total) ? { total: str(data.total)! } : {}), ...(str(data.date) ? { date: str(data.date)! } : {}) };
    const note = `Expense — ${f.merchant ?? "purchase"}: ${f.total ?? "?"}${f.date ? ` on ${f.date}` : ""}`;
    return { draftText: `🧾 Expense note:\n  ${note}`, fields: { ...f, note }, kind, route: "note", unverified: [] };
  }
  if (kind === "contact" && str(data.name) && (str(data.email) || str(data.phone))) {
    const f = { name: str(data.name)!, ...(str(data.email) ? { email: str(data.email)! } : {}), ...(str(data.phone) ? { phone: str(data.phone)! } : {}), ...(str(data.relationship) ? { relationship: str(data.relationship)! } : {}) };
    return { draftText: `👤 Contact:\n  name: ${f.name}${f.email ? `\n  email: ${f.email}` : ""}${f.phone ? `\n  phone: ${f.phone}` : ""}${f.relationship ? `\n  relationship: ${f.relationship}` : ""}`, fields: f, kind, route: "contact", unverified: [] };
  }
  if (kind === "document" && str(data.title) && str(data.body)) {
    const title = str(data.title)!;
    const body = str(data.body)!;
    const slug = title.toLowerCase().replace(/[^a-z0-9가-힣]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 60) || "note";
    return { draftText: `📝 Note "${title}":\n  ${body.length > 200 ? `${body.slice(0, 200)}…` : body}`, fields: { body, note: `# ${title}\n\n${body}\n`, path: `${slug}.md`, title }, kind, route: "note", unverified: [] };
  }
  return { draftText: "(couldn't route this image to an action — try --extract or a plain --image question)", fields: {}, kind: "other", route: "none", unverified: [] };
}
