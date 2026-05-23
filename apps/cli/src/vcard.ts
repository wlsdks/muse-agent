/**
 * Minimal vCard (.vcf) reader for `muse contacts import` — bulk-loads
 * an exported address book into the people graph. Pure + dependency-
 * free: covers the fields Muse's Contact model uses (FN / EMAIL / TEL /
 * BDAY / NICKNAME) across vCard 3.0 and 4.0, multiple cards per file.
 * Property parameters (`EMAIL;TYPE=work:`) are stripped; the first
 * EMAIL / TEL of a card wins.
 */

export interface ParsedVCard {
  readonly name: string;
  readonly email?: string;
  readonly phone?: string;
  readonly birthday?: string;
  readonly aliases?: readonly string[];
}

/** vCard line unfolding: a leading space/tab continues the previous line (RFC 6350 §3.2). */
function unfold(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    if ((raw.startsWith(" ") || raw.startsWith("\t")) && out.length > 0) {
      out[out.length - 1] += raw.slice(1);
    } else {
      out.push(raw);
    }
  }
  return out;
}

/** Split a content line into its property name (upper-cased, params dropped) and value. */
function splitLine(line: string): { property: string; value: string } | undefined {
  const colon = line.indexOf(":");
  if (colon < 0) {
    return undefined;
  }
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1).trim();
  const property = (head.split(";")[0] ?? "").trim().toUpperCase();
  if (property.length === 0) {
    return undefined;
  }
  return { property, value };
}

/**
 * Normalise a vCard BDAY to the Contact store's `MM-DD` / `YYYY-MM-DD`
 * shape: accepts `YYYY-MM-DD`, `YYYYMMDD`, `--MMDD` / `--MM-DD` (4.0
 * no-year), and `MM-DD`. Returns undefined when it isn't a date.
 */
export function normalizeVCardBirthday(raw: string): string | undefined {
  const v = raw.trim();
  let m = /^(\d{4})-?(\d{2})-?(\d{2})$/u.exec(v);
  if (m) {
    return `${m[1]}-${m[2]}-${m[3]}`;
  }
  m = /^--(\d{2})-?(\d{2})$/u.exec(v);
  if (m) {
    return `${m[1]}-${m[2]}`;
  }
  m = /^(\d{2})-(\d{2})$/u.exec(v);
  if (m) {
    return `${m[1]}-${m[2]}`;
  }
  return undefined;
}

/** Parse every `BEGIN:VCARD … END:VCARD` block in a .vcf file. Cards without an FN are skipped. */
export function parseVCards(text: string): ParsedVCard[] {
  const lines = unfold(text);
  const cards: ParsedVCard[] = [];
  let current: { name?: string; email?: string; phone?: string; birthday?: string; aliases: string[] } | undefined;
  for (const line of lines) {
    const parsed = splitLine(line);
    if (!parsed) {
      continue;
    }
    const { property, value } = parsed;
    if (property === "BEGIN" && value.toUpperCase() === "VCARD") {
      current = { aliases: [] };
      continue;
    }
    if (property === "END" && value.toUpperCase() === "VCARD") {
      if (current?.name) {
        cards.push({
          name: current.name,
          ...(current.email ? { email: current.email } : {}),
          ...(current.phone ? { phone: current.phone } : {}),
          ...(current.birthday ? { birthday: current.birthday } : {}),
          ...(current.aliases.length > 0 ? { aliases: current.aliases } : {})
        });
      }
      current = undefined;
      continue;
    }
    if (!current || value.length === 0) {
      continue;
    }
    switch (property) {
      case "FN":
        current.name = value;
        break;
      case "EMAIL":
        current.email ??= value;
        break;
      case "TEL":
        current.phone ??= value;
        break;
      case "BDAY": {
        const bday = normalizeVCardBirthday(value);
        if (bday) {
          current.birthday = bday;
        }
        break;
      }
      case "NICKNAME":
        for (const nick of value.split(",").map((n) => n.trim()).filter((n) => n.length > 0)) {
          current.aliases.push(nick);
        }
        break;
      default:
        break;
    }
  }
  return cards;
}
