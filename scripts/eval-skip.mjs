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
export const COMPLETION_MARKER = "MUSE_EVAL_COMPLETION";

const COMPLETION_STATUSES = new Set(["passed", "failed", "unverified"]);
const REASON_CODE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

function validateCompletion(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("completion must be an object");
  }
  const keys = Object.keys(value).sort();
  const allowed = value.reason === undefined
    ? ["executed", "requested", "status", "version"]
    : ["executed", "reason", "requested", "status", "version"];
  if (keys.length !== allowed.length || keys.some((key, index) => key !== allowed[index])) {
    throw new TypeError("completion contains unknown or missing fields");
  }
  if (value.version !== 1 || !COMPLETION_STATUSES.has(value.status)) {
    throw new TypeError("completion version or status is invalid");
  }
  if (!Number.isInteger(value.requested) || value.requested < 1) {
    throw new TypeError("requested must be a positive integer");
  }
  if (!Number.isInteger(value.executed) || value.executed < 0 || value.executed > value.requested) {
    throw new TypeError("executed must be an integer between zero and requested");
  }
  if (value.status === "passed" && value.executed !== value.requested) {
    throw new TypeError("executed must equal requested for a passed completion");
  }
  if (value.status === "unverified" && value.executed !== 0) {
    throw new TypeError("an unverified completion is a preflight result and must be emitted before any trial executes");
  }
  if (value.status === "unverified" && value.reason === undefined) {
    throw new TypeError("an unverified completion requires a stable reason code");
  }
  if (value.reason !== undefined && (typeof value.reason !== "string" || !REASON_CODE.test(value.reason))) {
    throw new TypeError("reason must be a stable reason code");
  }
  if (value.status === "passed" && value.reason !== undefined) {
    throw new TypeError("a passed completion cannot carry a reason");
  }
  return value;
}

/** Build the only structured evidence that a capability battery completed. */
export function completionLine({ status, requested, executed, reason }) {
  const completion = validateCompletion({
    version: 1,
    status,
    requested,
    executed,
    ...(reason === undefined ? {} : { reason }),
  });
  return `${COMPLETION_MARKER}:${JSON.stringify(completion)}`;
}

/** Parse exactly one strict completion marker, failing closed on ambiguity. */
export function parseCompletion(output) {
  const lines = String(output ?? "")
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(`${COMPLETION_MARKER}:`));
  if (lines.length === 0) {
    return { ok: false, reason: "missing-completion" };
  }
  if (lines.length !== 1) {
    return { ok: false, reason: "duplicate-completion" };
  }
  try {
    const completion = JSON.parse(lines[0].slice(COMPLETION_MARKER.length + 1));
    validateCompletion(completion);
    return { ok: true, completion };
  } catch {
    return { ok: false, reason: "invalid-completion" };
  }
}

/** Build the marker line a battery prints when it skips. */
/** Truthy MUSE_REQUIRE_LIVE turns "the environment was missing" into a hard failure. */
export function requireLiveFrom(env = process.env) {
  return ["1", "true", "yes", "on"].includes(String(env.MUSE_REQUIRE_LIVE ?? "").trim().toLowerCase());
}

/**
 * The exit code a battery should use when it skips. 0 keeps every existing caller working;
 * under MUSE_REQUIRE_LIVE it is EX_TEMPFAIL (75), which is non-zero for any orchestrator and
 * still distinguishable from a genuine assertion failure (1).
 */
export const SKIP_EXIT_CODE = 75;
export function skipExitCode(env = process.env) {
  return requireLiveFrom(env) ? SKIP_EXIT_CODE : 0;
}

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
export function classifyOutcome({ exitCode, skipCode, requireLive = false }) {
  if (exitCode !== 0) {
    return "fail";
  }
  // An unattended fire cannot read stdout prose. Under MUSE_REQUIRE_LIVE the absence of the
  // environment is a FAILURE, not a quiet pass: a loop that pushes on a green exit code while
  // every live battery silently skipped is the "ran the required check, ignored its result"
  // failure mode. Off by default so an interactive run on a laptop with no Ollama still works.
  if (requireLive && skipCode) {
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
