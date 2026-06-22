import type { Contact } from "@muse/stores";

interface ContactNetworkEdge {
  readonly name: string;
  readonly as?: string;
}

interface ContactNetworkSecondEdge {
  readonly name: string;
  readonly via: string;
  readonly as?: string;
}

export interface ContactNetwork {
  readonly direct: readonly ContactNetworkEdge[];
  readonly second: readonly ContactNetworkSecondEdge[];
}

const norm = (s: string): string => s.trim().toLowerCase();

/**
 * Traverse the people graph around `root` to depth 2: its DIRECT connections
 * (the edges `link` recorded) plus the 2nd-degree people it reaches THROUGH
 * those connections (friends-of-friends, each labelled with the via-person). A
 * connection's `to` is a NAME, so a 2nd hop only exists when that name is itself
 * a contact with its own connections. The root, the direct set, and duplicates
 * are excluded from the 2nd degree, so each person appears once at its nearest
 * distance. Pure.
 */
export function buildContactNetwork(contacts: readonly Contact[], root: Contact): ContactNetwork {
  const byName = new Map<string, Contact>();
  for (const c of contacts) {
    byName.set(norm(c.name), c);
  }
  const direct = (root.connections ?? []).map((e) => ({ name: e.to, ...(e.as ? { as: e.as } : {}) }));
  const excluded = new Set<string>([norm(root.name), ...direct.map((e) => norm(e.name))]);
  const second: ContactNetworkSecondEdge[] = [];
  const seen = new Set<string>();
  for (const d of direct) {
    const via = byName.get(norm(d.name));
    if (!via) {
      continue;
    }
    for (const e of via.connections ?? []) {
      const key = norm(e.to);
      if (excluded.has(key) || seen.has(key)) {
        continue;
      }
      seen.add(key);
      second.push({ name: e.to, via: d.name, ...(e.as ? { as: e.as } : {}) });
    }
  }
  return { direct, second };
}

/** Human-readable people-graph card for `muse contacts network <name>`. */
export function formatContactNetwork(rootName: string, network: ContactNetwork): string {
  if (network.direct.length === 0) {
    return `${rootName} has no recorded connections yet. Link them with: muse contacts link "${rootName}" <person> --as "<relation>"\n`;
  }
  const lines = [`${rootName}'s network:`, "  Direct:"];
  for (const e of network.direct) {
    lines.push(`    ↔ ${e.as ? `${e.as} ` : "connected to "}${e.name}`);
  }
  if (network.second.length > 0) {
    lines.push("  Through them:");
    for (const e of network.second) {
      lines.push(`    → ${e.name} (${e.as ? `${e.as} ${e.via}` : `via ${e.via}`})`);
    }
  }
  return `${lines.join("\n")}\n`;
}
