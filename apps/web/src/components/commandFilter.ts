// Rank command-palette entries for a query. Pure + testable so the component
// holds no search logic. Improves on a flat substring filter: a title PREFIX
// beats a mid-string hit, title beats group, and a fuzzy subsequence ("stng" →
// "Settings") still matches; multiple space-separated terms must ALL match
// (AND). Ties keep the original order (stable).

function isSubsequence(haystack: string, needle: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (i < needle.length && ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return needle.length === 0;
}

function scoreTerm(title: string, group: string, term: string): number {
  if (title.startsWith(term)) return 100;
  if (title.includes(term)) return 60;
  if (group.startsWith(term)) return 45;
  if (group.includes(term)) return 40;
  if (isSubsequence(title, term)) return 20;
  if (isSubsequence(group, term)) return 10;
  return 0;
}

export function rankCommands<T extends { title: string; group: string }>(
  commands: readonly T[],
  query: string
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands.slice();
  const terms = q.split(/\s+/);
  const scored: { cmd: T; total: number; order: number }[] = [];
  commands.forEach((cmd, order) => {
    const title = cmd.title.toLowerCase();
    const group = cmd.group.toLowerCase();
    let total = 0;
    let matched = true;
    for (const term of terms) {
      const s = scoreTerm(title, group, term);
      if (s === 0) {
        matched = false;
        break;
      }
      total += s;
    }
    if (matched) scored.push({ cmd, total, order });
  });
  scored.sort((a, b) => b.total - a.total || a.order - b.order);
  return scored.map((s) => s.cmd);
}
