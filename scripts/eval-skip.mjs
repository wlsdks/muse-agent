// Shared skip-telemetry for the eval aggregators.
//
// A live battery that exits 0 is either a real PASS (it did the work and every
// assertion held) or a SKIP (Ollama/embed-model/Chrome missing → it never ran).
// The aggregators used to count both as "ok", so a whole box with no model up —
// or, worse, Ollama up but the embed model not pulled (the nomic-not-pulled
// incident class) — read as an all-green gate. This module lets the aggregators
// tell the two apart from a battery's own stdout and FAIL when the reason is a
// pullable embed model rather than a genuinely-down environment.
//
// Pure + zero-dep; the classification helpers are unit-tested via
// `node --test scripts/eval-skip.test.mjs`.

// A battery MAY print this crisp marker to declare a skip and its reason; the
// legacy phrasing below is recognised too so un-migrated batteries still
// classify correctly. Codes: "ollama-unreachable" | "embed-model-missing" |
// "chrome-missing" | "skipped".
export const SKIP_MARKER = "MUSE_EVAL_SKIP";

/** Build the marker line a battery prints when it skips. */
export function skipLine(code, message) {
  return `${SKIP_MARKER}:${code}${message ? ` ${message}` : ""}`;
}

/**
 * The skip reason encoded in a battery's stdout, or null when the battery ran
 * to completion (a real pass/fail — no skip notice). The crisp `MUSE_EVAL_SKIP`
 * marker wins; otherwise the established `"<name> skipped — <reason>"` phrasing
 * is matched, but ONLY for the two reasons that matter to the gate (embed model
 * vs Ollama). An UNRECOGNISED "skipped" mention returns null — it degrades to
 * "ok" exactly like today, never mislabelling a genuine pass as a skip.
 */
export function classifySkip(stdout) {
  const s = String(stdout ?? "");
  const marker = s.match(new RegExp(`${SKIP_MARKER}:([\\w-]+)`, "u"));
  if (marker) {
    return marker[1];
  }
  // Legacy phrasing (batteries not carrying the marker). Anchored on the
  // "skipped —"/"skipped:" status token so a passing battery that merely
  // mentions "N skipped" cases is not misread as a skipped battery.
  const notice = s.match(/skipped\s*[—:-][^\n]*/giu);
  if (!notice) {
    return null;
  }
  const joined = notice.join("\n");
  if (/embed(?:der|ding)?\b|no index|embed endpoint/iu.test(joined)) {
    return "embed-model-missing";
  }
  if (/ollama[^\n]*(?:not reachable|unreachable)/iu.test(joined)) {
    return "ollama-unreachable";
  }
  return null;
}

/**
 * Map one battery run to a gate outcome. A skip whose reason is a MISSING EMBED
 * MODEL is a FAIL, not an "ok" skip: the embed-unavailable notice is printed
 * only AFTER a battery has confirmed Ollama is reachable, so this reason always
 * means "Ollama is up but nomic-embed isn't pulled" — a fixable misconfiguration
 * that would otherwise silently grey out every grounding battery. Every other
 * recognised skip (Ollama/Chrome down) stays a genuine skip.
 */
export function classifyOutcome({ exitCode, skipCode }) {
  if (exitCode !== 0) {
    return "fail";
  }
  if (skipCode === "embed-model-missing") {
    return "fail";
  }
  if (skipCode) {
    return "skip";
  }
  return "ok";
}
