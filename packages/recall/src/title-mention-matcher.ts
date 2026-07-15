/**
 * Multi-pattern substring search (Aho–Corasick, 1975) for title-mention
 * edges: ONE pass over each note body finds every note title it mentions,
 * replacing the per-title `includes` loop that made the graph build
 * O(titles × total-chars) — measured 6.8s per ask at 10k notes vs 9ms for
 * the wikilink-only build. Hand-rolled (~90 lines) over an npm dependency:
 * the algorithm is public knowledge and the codebase carries zero-dep bias.
 * Patterns and text must be pre-normalized by the caller (NFC + lowercase)
 * so Korean NFD filenames and NFC body text meet in one space.
 */

interface AcNode {
  readonly children: Map<string, AcNode>;
  fail: AcNode | null;
  /** Pattern indices ending at this node (own + inherited via fail links). */
  readonly output: number[];
}

const makeNode = (): AcNode => ({ children: new Map(), fail: null, output: [] });

export class TitleMentionMatcher {
  private readonly root = makeNode();
  private readonly patterns: readonly string[];

  constructor(patterns: readonly string[]) {
    this.patterns = patterns;
    patterns.forEach((pattern, index) => {
      let node = this.root;
      for (const ch of pattern) {
        let next = node.children.get(ch);
        if (!next) {
          next = makeNode();
          node.children.set(ch, next);
        }
        node = next;
      }
      node.output.push(index);
    });
    // BFS failure links (KMP generalized to a trie).
    const queue: AcNode[] = [];
    for (const child of this.root.children.values()) {
      child.fail = this.root;
      queue.push(child);
    }
    while (queue.length > 0) {
      const node = queue.shift()!;
      for (const [ch, child] of node.children) {
        let fail = node.fail;
        while (fail && !fail.children.has(ch)) {
          fail = fail.fail;
        }
        child.fail = fail?.children.get(ch) ?? this.root;
        child.output.push(...child.fail.output);
        queue.push(child);
      }
    }
  }

  /** Indices of every pattern occurring in `text`, deduped. One pass, O(text). */
  match(text: string): ReadonlySet<number> {
    const found = new Set<number>();
    if (this.patterns.length === 0) {
      return found;
    }
    let node: AcNode = this.root;
    for (const ch of text) {
      while (node !== this.root && !node.children.has(ch)) {
        node = node.fail ?? this.root;
      }
      node = node.children.get(ch) ?? this.root;
      for (const index of node.output) {
        found.add(index);
      }
      if (found.size === this.patterns.length) {
        break;
      }
    }
    return found;
  }
}
