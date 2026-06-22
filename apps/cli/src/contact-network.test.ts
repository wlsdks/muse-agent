import type { Contact } from "@muse/stores";
import { describe, expect, it } from "vitest";

import { buildContactNetwork, formatContactNetwork } from "./contact-network.js";

const c = (name: string, connections: { to: string; as?: string }[] = []): Contact => ({
  id: name.toLowerCase(),
  name,
  connections
});

describe("buildContactNetwork — traverse the people graph to depth 2", () => {
  const bob = c("Bob", [{ to: "Alice", as: "works with" }, { to: "Carol", as: "manager" }]);
  const alice = c("Alice", [{ to: "Bob", as: "works with" }, { to: "Dave", as: "friends with" }]);
  const carol = c("Carol", [{ to: "Bob", as: "manager" }]);
  const dave = c("Dave", [{ to: "Alice", as: "friends with" }]);
  const all = [bob, alice, carol, dave];

  it("lists the root's direct connections in order", () => {
    expect(buildContactNetwork(all, bob).direct).toEqual([
      { name: "Alice", as: "works with" },
      { name: "Carol", as: "manager" }
    ]);
  });

  it("reaches Dave at 2nd degree THROUGH Alice and labels the via-person", () => {
    expect(buildContactNetwork(all, bob).second).toEqual([{ name: "Dave", via: "Alice", as: "friends with" }]);
  });

  it("excludes the root and direct connections from the 2nd degree", () => {
    const names = buildContactNetwork(all, bob).second.map((e) => e.name);
    expect(names).not.toContain("Bob"); // the root
    expect(names).not.toContain("Alice"); // already direct
    expect(names).not.toContain("Carol"); // already direct
  });

  it("returns an empty network for a contact with no connections", () => {
    const net = buildContactNetwork(all, c("Zoe"));
    expect(net.direct).toEqual([]);
    expect(net.second).toEqual([]);
  });

  it("does NOT 2nd-hop through a connection name that isn't itself a contact (leaf name)", () => {
    const ed = c("Ed", [{ to: "External Person", as: "knows" }]);
    const net = buildContactNetwork([ed], ed);
    expect(net.direct).toEqual([{ name: "External Person", as: "knows" }]);
    expect(net.second).toEqual([]);
  });

  it("dedupes a 2nd-degree person reachable via multiple direct connections", () => {
    const b = c("B", [{ to: "Al" }, { to: "Ca" }]);
    const al = c("Al", [{ to: "Frank", as: "x" }]);
    const ca = c("Ca", [{ to: "Frank", as: "y" }]);
    expect(buildContactNetwork([b, al, ca], b).second.filter((e) => e.name === "Frank")).toHaveLength(1);
  });

  it("matches connection names case-insensitively when resolving the 2nd hop", () => {
    const root = c("Root", [{ to: "alice" }]); // lower-case in the edge
    const linked = c("Alice", [{ to: "Grace", as: "sister" }]); // capitalised contact
    expect(buildContactNetwork([root, linked], root).second).toEqual([{ name: "Grace", via: "alice", as: "sister" }]);
  });
});

describe("formatContactNetwork", () => {
  it("renders the Direct and Through-them sections", () => {
    const out = formatContactNetwork("Bob", {
      direct: [{ name: "Alice", as: "works with" }],
      second: [{ name: "Dave", via: "Alice", as: "friends with" }]
    });
    expect(out).toContain("Bob's network:");
    expect(out).toContain("↔ works with Alice");
    expect(out).toContain("→ Dave (friends with Alice)");
  });

  it("falls back to 'connected to' when an edge has no relation label", () => {
    const out = formatContactNetwork("Bob", { direct: [{ name: "Alice" }], second: [{ name: "Dave", via: "Alice" }] });
    expect(out).toContain("↔ connected to Alice");
    expect(out).toContain("→ Dave (via Alice)");
  });

  it("guides the user to link when there are no connections", () => {
    const out = formatContactNetwork("Zoe", { direct: [], second: [] });
    expect(out).toContain("no recorded connections");
    expect(out).toContain("muse contacts link");
  });
});
