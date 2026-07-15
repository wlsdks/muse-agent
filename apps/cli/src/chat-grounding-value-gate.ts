import { monthDayKeys, stripCitationMarkers, type KnowledgeMatch } from "@muse/agent-core";

// The deterministic anti-fabrication value guards for the conversational
// surface: pure, sync, no-model-call checks that a number / email / URL /
// identifier / IP / date the answer asserts actually appears in the retrieved
// evidence (or the question). Each asserted value is a VERBATIM, copy-only
// identifier that never paraphrases, so requiring it in the evidence is
// false-refusal-safe yet catches the highest-harm fabrication class the holistic
// coverage rubric waves through.

// Canonical digit string for a written number: strip thousands separators so
// "1,250,000" and "1250000" compare equal. Only runs of >= 3 digits are treated
// as VALUES — 1-2 digit numbers are counts / ordinals ("the 1st", "12th",
// "serves 4") and date parts ("…-02-28"), whose reformatting ("3" vs "03",
// "Sep 14") would otherwise cause false refusals.
function valueNumbers(text: string): Set<string> {
  const out = new Set<string>();
  for (const run of text.match(/\d[\d,]*\d|\d/gu) ?? []) {
    const digits = run.replace(/,/gu, "");
    if (digits.length >= 3) out.add(digits);
  }
  return out;
}

function buildQuestionAndEvidenceText(question: string, matches: readonly KnowledgeMatch[]): string {
  if (matches.length === 0) {
    return stripCitationMarkers(question);
  }
  return stripCitationMarkers(`${question} ${matches.map((match) => match.text).join(" ")}`);
}

function citedText(text: string): string {
  return stripCitationMarkers(text);
}

/**
 * Does the answer assert a substantive NUMBER present in neither the retrieved
 * evidence nor the question? `muse ask` catches this wrong-VALUE drift with a
 * judge pass (`answerAssertsUnsupportedValue` → reverify, fail-open), but the
 * chat gate is sync-by-design with no model call, so it needs a DETERMINISTIC
 * equivalent. Numbers don't paraphrase, so the false-positive rate is ~0
 * (protecting false-refusal=0); restricting to >= 3-digit values targets the
 * highest-harm class the holistic `coverage` / `noteGroundedAnswer` shortcuts
 * wave through — a wrong MTU (1500 vs the note's 1380), a wrong rent, a
 * fabricated price/phone. Claim-level support applied as code (FActScore atomic
 * facts, Self-RAG ISSUP — arXiv:2305.14251, arXiv:2310.11511). Citations are
 * stripped first so a `[from …2026…]` source is never read as an asserted value.
 */
export function answerAssertsUnsupportedNumber(
  answer: string,
  matches: readonly KnowledgeMatch[],
  question: string
): boolean {
  const answerNumbers = valueNumbers(citedText(answer));
  if (answerNumbers.size === 0) return false;
  const supported = valueNumbers(buildQuestionAndEvidenceText(question, matches));
  for (const number of answerNumbers) {
    if (!supported.has(number)) return true;
  }
  return false;
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/giu;

/**
 * Does the answer assert an EMAIL ADDRESS present in neither the evidence nor
 * the question? Same rationale as {@link answerAssertsUnsupportedNumber}: an
 * email is a verbatim-copied identifier (never paraphrased), so requiring it to
 * appear in the evidence text is false-positive-safe yet catches the highest-harm
 * contact drift — a right local-part with a WRONG domain ("jinan@acme.com" for
 * the note's "jinan@foundry.io"), which the `noteGroundedAnswer` token shortcut
 * waves through because the local-part overlaps the note. A wrong contact address
 * is an outbound-safety hazard, so the chat gate must refuse it as ask does
 * (agent-core's value escalation). Addresses are compared whole, case-insensitively.
 */
export function answerAssertsUnsupportedEmail(
  answer: string,
  matches: readonly KnowledgeMatch[],
  question: string
): boolean {
  const assertedEmails = citedText(answer)
    .match(EMAIL_RE) ?? [];
  if (assertedEmails.length === 0) return false;
  const assertedEmailSet = new Set<string>(assertedEmails.map((address) => address.toLowerCase()));
  const evidenceEmails = new Set<string>();
  for (const address of buildQuestionAndEvidenceText(question, matches).toLowerCase().match(EMAIL_RE) ?? []) {
    evidenceEmails.add(address);
  }
  for (const address of assertedEmailSet) {
    if (!evidenceEmails.has(address)) return true;
  }
  return false;
}

// A bare host or http(s) URL the answer asserts. The first alternative matches an
// http(s):// URL; the second a bare `host.tld` domain — at least two dot-joined
// labels ending in a real (>= 2 letter, no-digit) TLD. The leading boundary keeps
// it from biting an email's domain part ("@foundry.io") or a path-internal token.
const URL_RE = /\bhttps?:\/\/[^\s)\]}>"']+|\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?:\/[^\s)\]}>"']*)?/giu;

// Canonicalize a URL/domain to its bare host: lowercase, drop the scheme, drop a
// leading `www.`, and drop everything from the first path/query/fragment separator
// or a trailing dot — so the SAME host written with a different scheme / www. /
// trailing-slash / path compares equal (a supported URL re-rendered must NOT refuse).
function canonicalHost(urlOrHost: string): string {
  let host = urlOrHost.trim().toLowerCase().replace(/^https?:\/\//u, "");
  host = host.split(/[/?#]/u)[0] ?? host;
  host = host.replace(/^www\./u, "").replace(/\.+$/u, "");
  return host;
}

// Unambiguous file extensions that are NOT registrable TLDs — a BARE token like
// "report.txt" / "photo.png" is a filename, not a domain, so treating it as an
// asserted host would false-refuse a legitimate answer. This set DELIBERATELY
// excludes extensions that double as real ccTLDs/gTLDs (md=Moldova, io, sh, ai, ts,
// me, co, app, dev, …) so a poisoned "acme-login.md" domain stays guarded. Only
// the BARE-domain branch is filtered; an explicit http(s):// URL is always a host.
// NB: deliberately OMITS zip + mov — both are real Google gTLDs (delegated 2023),
// so a "acme-backup.zip" / "team-video.mov" can be a registrable phishing domain
// and MUST stay guarded. Every entry below is verified NOT in the IANA root zone.
const NON_TLD_FILE_EXTENSIONS = new Set([
  "txt", "json", "jsonl", "csv", "tsv", "log", "pdf", "png", "jpg", "jpeg", "gif",
  "svg", "webp", "docx", "xlsx", "pptx", "gz", "tar", "yaml", "yml", "toml",
  "lock", "html", "css", "mp3", "mp4", "wav"
]);

// The set of canonical hosts a text asserts (URLs + bare domains), citations stripped.
function answerHosts(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.match(URL_RE) ?? []) {
    const host = canonicalHost(raw);
    if (host.length === 0) continue;
    // A bare (non-scheme) token whose final label is an unambiguous file extension
    // is a filename, not a domain — don't treat it as an asserted host.
    if (!/^https?:\/\//iu.test(raw.trim())) {
      const lastLabel = host.split(".").pop() ?? "";
      if (NON_TLD_FILE_EXTENSIONS.has(lastLabel)) continue;
    }
    out.add(host);
  }
  return out;
}

/**
 * Does the answer assert a URL / bare domain whose HOST appears in neither the
 * evidence nor the question? Same rationale as {@link answerAssertsUnsupportedEmail}:
 * a bare domain ("acme-login.com") has no >= 3-digit run and splits on `.` into
 * pure-alpha parts, so the number AND identifier guards both wave it through, and a
 * note-overlapping prose answer makes verifyGrounding's coverage rubric score it
 * `grounded` — a FABRICATED login/portal link surfaced as the user's own data
 * (phishing-adjacent: Netcraft found 34% of LLM brand-login URLs wrong, one a live
 * phishing site). A host is a verbatim, copy-only identifier that never paraphrases,
 * so requiring it in the evidence is false-refusal-safe. Compared by CANONICAL host
 * (scheme/www./path/trailing-slash stripped) so a supported URL re-rendered another
 * way — or a host the user supplied in the question — never refuses.
 */
export function answerAssertsUnsupportedUrl(
  answer: string,
  matches: readonly KnowledgeMatch[],
  question: string
): boolean {
  const hosts = answerHosts(citedText(answer));
  if (hosts.size === 0) return false;
  const supported = answerHosts(buildQuestionAndEvidenceText(question, matches));
  for (const host of hosts) {
    if (!supported.has(host)) return true;
  }
  return false;
}

// An IDENTIFIER token mixes letters AND digits (optionally hyphen-joined): an
// SSID, model number, interface tag, room code — "Nest-5G", "wg0", "B205". Like
// a number or email it is a VERBATIM identifier that never paraphrases, so the
// false-positive rate of requiring it in the evidence is ~0. A pure-digit run
// ("192", "2029-11-03") or pure-letter word ("KRW", "Park") is NOT an
// identifier — those are handled by answerAssertsUnsupportedNumber or are
// paraphrasable prose.
// Canonicalize to the alphanumeric core (drop case + every separator) so a
// copied identifier re-rendered with a different separator — "Nest-5G" vs
// "Nest 5G" vs "nest5g" — compares equal. Without this the guard would FALSE-
// REFUSE a correct answer that merely spaced the value differently.
function canonicalIdentifier(token: string): string {
  return token.toLowerCase().replace(/[^a-z0-9]/giu, "");
}

// The mixed letter+digit identifier tokens an answer asserts, in canonical form.
function answerIdentifiers(text: string): ReadonlySet<string> {
  const out = new Set<string>();
  for (const token of text.match(/[a-z0-9]+(?:-[a-z0-9]+)*/giu) ?? []) {
    if (/[a-z]/iu.test(token) && /\d/u.test(token)) out.add(canonicalIdentifier(token));
  }
  return out;
}

/**
 * Does the answer assert a mixed letter+digit IDENTIFIER present in neither the
 * evidence nor the question? The string-drift counterpart to
 * {@link answerAssertsUnsupportedNumber}: a wrong SSID ("Linksys-2G" for the
 * note's "Nest-5G") has only a 1-digit run, so the number guard waves it
 * through, and its heavy lexical overlap with the note ("home wifi SSID is …")
 * makes verifyGrounding's coverage rubric score it `grounded` — a fabrication
 * surfaced on the chat surface. Identifiers don't paraphrase, so requiring a
 * verbatim match is false-refusal-safe. (A wrong PURE-ALPHABETIC proper noun —
 * "Mr. Lee" for "Mr. Park" — is NOT covered here: names paraphrase across
 * scripts/titles, so a lexical rule would false-refuse; that residual needs NER
 * or a judge, neither of which fits this sync, no-model-call gate.)
 */
export function answerAssertsUnsupportedIdentifier(
  answer: string,
  matches: readonly KnowledgeMatch[],
  question: string
): boolean {
  const answerIds = answerIdentifiers(citedText(answer));
  if (answerIds.size === 0) return false;
  // Substring (not token-equality) against the canonical evidence+question so a
  // separator-variant rendering of a SUPPORTED identifier still matches; only an
  // identifier absent from the evidence in any form is flagged.
  const haystack = canonicalIdentifier(buildQuestionAndEvidenceText(question, matches));
  for (const id of answerIds) {
    if (!haystack.includes(id)) return true;
  }
  return false;
}

// Each octet is constrained to 0-255, so the pattern matches a real IPv4 and
// NOT an IP-shaped non-address: a version string ("1.2.3" — only 3 groups), a
// decimal ("3.14"), or a date ("2029-11-03" — hyphens, not dots).
const IPV4_RE = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/gu;

// Collapse the only legitimate re-render of an octet (leading zeros: "01" → "1")
// so a correct address written either way compares equal.
function canonicalIp(ip: string): string {
  return ip.split(".").map((octet) => String(Number.parseInt(octet, 10))).join(".");
}

/**
 * Does the answer assert a whole IPv4 address present in neither the evidence
 * nor the question? {@link answerAssertsUnsupportedNumber} compares >=3-digit
 * runs, so it judges an IP octet-by-octet: "192.168.0.1" and a drifted
 * "192.168.1.1" both reduce to the supported set {192,168} (the 0/1 octets are
 * 1-digit and dropped), and "10.0.0.5" reduces to {} — so a wrong router/admin
 * IP is waved through and surfaced. An IPv4 literal is a verbatim, copy-only
 * identifier that never paraphrases, so matching the WHOLE address is
 * false-refusal-safe; it must run before the number guard splits it into octets.
 */
export function answerAssertsUnsupportedIpAddress(
  answer: string,
  matches: readonly KnowledgeMatch[],
  question: string
): boolean {
  const answerIps = citedText(answer).match(IPV4_RE) ?? [];
  if (answerIps.length === 0) return false;
  const supported = new Set<string>([
    ...(buildQuestionAndEvidenceText(question, matches).match(IPV4_RE) ?? []).map(canonicalIp)
  ]);
  for (const rawIp of answerIps) {
    const ip = canonicalIp(rawIp);
    if (!supported.has(ip)) return true;
  }
  return false;
}

// `monthDayKeys` now lives in @muse/agent-core (one shared copy across the chat date gate
// and the ask-path value guard — no divergence). Imported at the top of this file.

/**
 * Does the answer assert an ISO date (YYYY-MM-DD) that none of the evidence dates
 * support? The number guard drops 1-2 digit runs (date parts) and only sees the
 * 4-digit YEAR, so a drifted day/month over the SAME year (note 2026-09-13,
 * answer 2026-09-14) slips through and a wrong calendar/renewal/deadline date is
 * surfaced as grounded — the date analog of the whole-IPv4 guard. Matches on a
 * script-neutral month-day key across ISO ("2026-09-14"), English prose ("September
 * 14" — the form the calendar grounding block renders) and Korean ("9월 14일"), so a
 * drifted prose calendar date is caught too, not only ISO. Conservative to keep
 * false-refusal ~0: fires ONLY when the evidence ALSO carries a concrete date and the
 * answer's month-day matches none; a month-only mention ("in September") is left
 * alone. Year is dropped (the number guard owns it). Citations stripped first.
 */
export function answerAssertsUnsupportedDate(
  answer: string,
  matches: readonly KnowledgeMatch[],
  question: string
): boolean {
  const answerDates = monthDayKeys(citedText(answer));
  if (answerDates.size === 0) return false;
  const supported = monthDayKeys(buildQuestionAndEvidenceText(question, matches));
  if (supported.size === 0) return false;
  return [...answerDates].some((date) => !supported.has(date));
}
