/**
 * `muse ask`'s pure time-zone fast-path — the cross-zone-scheduling sibling of
 * the arithmetic / date / unit / percentage fast-paths. The local 8B doesn't
 * reliably know the current time, the UTC offsets, or DST, so a query that is
 * nothing but "what's 9am PST in Seoul?" or "what time is it in Tokyo?" is
 * answered EXACTLY here from the host clock + the IANA database (via `Intl`, no
 * dependency). Precision-first: it fires ONLY when every named zone resolves, so
 * a non-timezone question ("what time is the meeting?") falls through to recall.
 */

interface Zone {
  readonly iana: string;
  readonly label: string;
}

const ZONES: Record<string, Zone> = {};
function registerZone(iana: string, label: string, ...keys: readonly string[]): void {
  for (const key of keys) {
    ZONES[key] = { iana, label };
  }
}
registerZone("UTC", "UTC", "utc", "gmt", "zulu");
registerZone("America/Los_Angeles", "Los Angeles", "pst", "pdt", "pt", "los angeles", "la", "san francisco", "seattle", "pacific", "로스앤젤레스", "엘에이", "샌프란시스코", "시애틀");
registerZone("America/Denver", "Denver", "mst", "mdt", "mt", "denver", "mountain", "덴버");
registerZone("America/Chicago", "Chicago", "cst", "cdt", "ct", "chicago", "central", "dallas", "austin", "시카고");
registerZone("America/New_York", "New York", "est", "edt", "et", "new york", "nyc", "boston", "eastern", "miami", "toronto", "뉴욕", "보스턴", "토론토");
registerZone("Europe/London", "London", "bst", "london", "uk", "런던", "영국");
registerZone("Europe/Paris", "Paris", "cet", "cest", "paris", "berlin", "madrid", "rome", "amsterdam", "파리", "베를린", "마드리드", "로마", "암스테르담");
registerZone("Asia/Kolkata", "India", "ist", "india", "mumbai", "delhi", "bangalore", "bengaluru", "인도", "뭄바이", "델리");
registerZone("Asia/Tokyo", "Tokyo", "jst", "tokyo", "japan", "osaka", "도쿄", "일본", "오사카");
registerZone("Asia/Seoul", "Seoul", "kst", "seoul", "korea", "서울", "한국");
registerZone("Asia/Shanghai", "China", "shanghai", "beijing", "china", "상하이", "베이징", "중국");
registerZone("Asia/Hong_Kong", "Hong Kong", "hong kong", "hk", "홍콩");
registerZone("Asia/Singapore", "Singapore", "singapore", "sgt", "싱가포르");
registerZone("Asia/Dubai", "Dubai", "dubai", "uae", "gst", "두바이");
registerZone("Australia/Sydney", "Sydney", "sydney", "aest", "aedt", "melbourne", "시드니", "멜버른");

function resolveZone(phrase: string): Zone | undefined {
  return ZONES[phrase.trim().toLowerCase().replace(/\s+/gu, " ")];
}

/** The UTC offset (ms) of `tz` at the instant `date` — DST-correct via Intl. */
function zoneOffsetMs(date: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(date)) {
    p[part.type] = part.value;
  }
  const asUTC = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return asUTC - date.getTime();
}

/** Parse "3pm" / "3:30 pm" / "15:00" / "9 am" / "noon" / "midnight" to minutes-since-midnight, or null. */
function parseClock(raw: string): number | null {
  const t = raw.trim().toLowerCase();
  if (t === "noon") return 12 * 60;
  if (t === "midnight") return 0;
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/u.exec(t);
  if (!m) return null;
  let hour = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const mer = m[3];
  if (hour > 23 || min > 59) return null;
  if (mer === "pm" && hour < 12) hour += 12;
  if (mer === "am" && hour === 12) hour = 0;
  if (!mer && hour > 23) return null;
  return hour * 60 + min;
}

function formatClock(minutes: number): string {
  const h24 = Math.floor(minutes / 60);
  const min = minutes % 60;
  const mer = h24 < 12 ? "AM" : "PM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12.toString()}:${min.toString().padStart(2, "0")} ${mer}`;
}

export type TimezoneQuery =
  | { readonly kind: "convert"; readonly minutes: number; readonly from: Zone; readonly to: Zone; readonly ko: boolean }
  | { readonly kind: "now"; readonly to: Zone; readonly ko: boolean };

const NOW_RE = /^(?:what(?:'s| is)?\s+(?:the\s+)?time(?:\s+is\s+it)?|what\s+time\s+is\s+it|current\s+time)\s+in\s+(.+?)(?:\s+(?:right\s+)?now)?$/u;
const CONVERT_RE = /^(?:what\s+time\s+is\s+|what(?:'s| is)?\s+|whats\s+|convert\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|noon|midnight)\s+(.+?)\s+(?:in|to)\s+(.+?)(?:\s+time)?$/u;

// Korean is suffix-framed: the zone(s) lead and the question word trails.
// convert: "<from> <time>(은/는) <to>(로/으로)? (시간)? 몇 시" ; now: "(지금)? <zone>
// (지금)? (시간)? 몇 시" / "지금 <zone> 시간". parseClock-equivalent for Korean
// clock spellings handles the time part.
const KO_TZ_TIME = "(?:오전|오후)?\\s*\\d{1,2}\\s*시(?:\\s*\\d{1,2}\\s*분)?|정오|자정";
const KO_CONVERT_RE = new RegExp(`^(.+?)\\s+(${KO_TZ_TIME})\\s*(?:은|는)?\\s+(.+?)\\s*(?:로|으로|에서|기준)?\\s*(?:시간\\s*)?(?:몇\\s*시|시간)`, "u");
const KO_NOW_RE = /^(?:지금\s+)?(.+?)\s*(?:지금\s+)?(?:시간(?:은|이)?\s*)?(?:몇\s*시(?:야|예요|인가요|이야)?|시간)\s*(?:야|예요|인가요)?$/u;

/** Parse a Korean clock spelling ("오후 3시", "오전 9시 30분", "정오", "자정") to minutes, or null. */
function parseKoClock(raw: string): number | null {
  const t = raw.trim();
  if (t === "정오") return 12 * 60;
  if (t === "자정") return 0;
  const m = /^(오전|오후)?\s*(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?$/u.exec(t);
  if (!m) return null;
  let hour = Number(m[2]);
  const min = m[3] ? Number(m[3]) : 0;
  if (hour > 23 || min > 59) return null;
  if (m[1] === "오후" && hour < 12) hour += 12;
  if (m[1] === "오전" && hour === 12) hour = 0;
  return hour * 60 + min;
}

/**
 * Detect a pure time-zone question and return its parts, or null. Handles the
 * English "<time> <zone> in/to <zone>" / "what time is it in <zone>" AND the
 * Korean suffix-framed "<from> <time> <to> 몇 시" / "지금 <zone> 몇 시". Returns
 * null unless every named zone resolves AND (for convert) the time parses, so a
 * non-timezone question never short-circuits recall.
 */
export function detectTimezoneQuery(query: string): TimezoneQuery | null {
  const raw = query.trim().replace(/[?.!]+$/u, "").trim();
  if (/[가-힣]/u.test(raw)) {
    const kc = KO_CONVERT_RE.exec(raw);
    if (kc) {
      const minutes = parseKoClock(kc[2]!);
      const from = resolveZone(kc[1]!);
      const to = resolveZone(kc[3]!);
      if (minutes !== null && from && to) {
        return { from, ko: true, kind: "convert", minutes, to };
      }
    }
    const kn = KO_NOW_RE.exec(raw);
    if (kn) {
      const to = resolveZone(kn[1]!);
      if (to) {
        return { ko: true, kind: "now", to };
      }
    }
    return null;
  }
  const q = raw.toLowerCase();
  const nowMatch = NOW_RE.exec(q);
  if (nowMatch) {
    const to = resolveZone(nowMatch[1]!);
    if (to) return { ko: false, kind: "now", to };
    return null;
  }
  const conv = CONVERT_RE.exec(q);
  if (conv) {
    const minutes = parseClock(conv[1]!);
    const from = resolveZone(conv[2]!);
    const to = resolveZone(conv[3]!);
    if (minutes !== null && from && to) {
      return { from, ko: false, kind: "convert", minutes, to };
    }
  }
  return null;
}

/** "오후 3시" / "오전 4시 30분" — a Korean clock rendering of minutes-since-midnight. */
function formatKoClock(minutes: number): string {
  const h24 = Math.floor(minutes / 60);
  const min = minutes % 60;
  const mer = h24 < 12 ? "오전" : "오후";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return min === 0 ? `${mer} ${h12.toString()}시` : `${mer} ${h12.toString()}시 ${min.toString()}분`;
}

/** The exact answer for a detected time-zone query, computed against `now`. Pure given `now`. */
export function formatTimezone(q: TimezoneQuery, now: Date): string {
  if (q.kind === "now") {
    const here = q.to;
    const local = new Date(now.getTime() + zoneOffsetMs(now, here.iana));
    const mins = local.getUTCHours() * 60 + local.getUTCMinutes();
    if (q.ko) {
      return `지금 ${here.label}는 ${formatKoClock(mins)}입니다.`;
    }
    return `It's ${formatClock(mins)} in ${here.label} right now.`;
  }
  const diffMin = (zoneOffsetMs(now, q.to.iana) - zoneOffsetMs(now, q.from.iana)) / 60000;
  const total = q.minutes + diffMin;
  const dayShift = Math.floor(total / 1440);
  const tgtMin = ((total % 1440) + 1440) % 1440;
  if (q.ko) {
    const koDayNote = dayShift > 0 ? " (다음 날)" : dayShift < 0 ? " (전날)" : "";
    return `${q.from.label} ${formatKoClock(q.minutes)}는 ${q.to.label} ${formatKoClock(tgtMin)}입니다${koDayNote}.`;
  }
  const dayNote = dayShift > 0 ? " (next day)" : dayShift < 0 ? " (previous day)" : "";
  return `${formatClock(q.minutes)} ${q.from.label} is ${formatClock(tgtMin)} in ${q.to.label}${dayNote}.`;
}
